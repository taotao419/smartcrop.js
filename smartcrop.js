/**
 * smartcrop.js
 * A javascript library implementing content aware image cropping
 *
 * Copyright (C) 2018 Jonas Wagner
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

(function() {
  'use strict';

  var smartcrop = {};
  // Promise implementation to use
  // Promise 就是一个对象，用来传递异步操作的消息。它代表了某个未来才会知道结果的事件（通常是一个异步操作）
  smartcrop.Promise =
    typeof Promise !== 'undefined' ?
    Promise :
    function() {
      throw new Error('No native promises and smartcrop.Promise not set.');
    };

  smartcrop.DEFAULTS = {
    width: 0,
    height: 0,
    aspect: 0,
    cropWidth: 0,
    cropHeight: 0,
    detailWeight: 0.2,
    skinColor: [0.78, 0.57, 0.44],
    skinBias: 0.01,
    skinBrightnessMin: 0.2,
    skinBrightnessMax: 1.0,
    skinThreshold: 0.8,
    skinWeight: 1.8,
    saturationBrightnessMin: 0.05,
    saturationBrightnessMax: 0.9,
    saturationThreshold: 0.4,
    saturationBias: 0.2,
    saturationWeight: 0.1,
    // Step * minscale rounded down to the next power of two should be good
    scoreDownSample: 8,
    step: 8,
    scaleStep: 0.1,
    minScale: 1.0,
    maxScale: 1.0,
    edgeRadius: 0.4,
    edgeWeight: -20.0,
    outsideImportance: -0.5,
    boostWeight: 100.0,
    ruleOfThirds: true,
    prescale: true,
    imageOperations: null,
    canvasFactory: defaultCanvasFactory,
    // Factory: defaultFactories,
    debug: false
  };

  smartcrop.crop = function(inputImage, options_, callback) {
    var options = extend({}, smartcrop.DEFAULTS, options_);

    if (options.aspect) {
      options.width = options.aspect;
      options.height = 1;
    }

    if (options.imageOperations === null) {
      options.imageOperations = canvasImageOperations(options.canvasFactory);
    }

    var iop = options.imageOperations;

    var scale = 1;
    var prescale = 1;

    // open the image
    return iop
      .open(inputImage, options.input) //Javascript Promise : eventual completion (or failure) of an asynchronous operation, and its resulting value.
      .then(function(image) {
        // calculate desired crop dimensions based on the image size
        if (options.width && options.height) {
          scale = min(
            image.width / options.width,
            image.height / options.height
          );
          options.cropWidth = ~~(options.width * scale);
          options.cropHeight = ~~(options.height * scale);
          // Img = 100x100, width = 95x95, scale = 100/95, 1/scale > min
          // don't set minscale smaller than 1/scale
          // -> don't pick crops that need upscaling
          options.minScale = min(
            options.maxScale,
            max(1 / scale, options.minScale)
          );

          // prescale if possible
          if (options.prescale !== false) {
            prescale = min(max(256 / image.width, 256 / image.height), 1);
            if (prescale < 1) {
              image = iop.resample(
                image,
                image.width * prescale,
                image.height * prescale
              );
              options.cropWidth = ~~(options.cropWidth * prescale);
              options.cropHeight = ~~(options.cropHeight * prescale);
              if (options.boost) {
                options.boost = options.boost.map(function(boost) {
                  return {
                    x: ~~(boost.x * prescale),
                    y: ~~(boost.y * prescale),
                    width: ~~(boost.width * prescale),
                    height: ~~(boost.height * prescale),
                    weight: boost.weight
                  };
                });
              }
            } else {
              prescale = 1;
            }
          }
        }
        return image;
      })
      .then(function(image) {
        return iop.getData(image).then(function(data) {
          var result = analyse(options, data);

          var crops = result.crops || [result.topCrop];
          for (var i = 0, iLen = crops.length; i < iLen; i++) {
            var crop = crops[i];
            crop.x = ~~(crop.x / prescale);
            crop.y = ~~(crop.y / prescale);
            crop.width = ~~(crop.width / prescale);
            crop.height = ~~(crop.height / prescale);
          }
          if (callback) callback(result);
          return result;
        });
      });
  };

  // Check if all the dependencies are there
  // todo:
  smartcrop.isAvailable = function(options) {
    if (!smartcrop.Promise) return false;

    var canvasFactory = options ? options.canvasFactory : defaultCanvasFactory;

    if (canvasFactory === defaultCanvasFactory) {
      var c = document.createElement('canvas');
      if (!c.getContext('2d')) {
        return false;
      }
    }

    return true;
  };

  /*
  https://www.jianshu.com/p/2334bee37de5  -- [数字图像 - 边缘检测原理 - Sobel, Laplace, Canny算子]
  其中解释了为啥要用二阶导数,因为在变化处/边缘
  拉普拉斯是用二阶导数计算边缘,在连续函数下 , 在一阶导数图中极大值或极小值处 是边缘
  在二阶导数图中 极大值或极小值之间过0点 被认为是边缘
  导数基本公式: h: lim->0  (f(x+h)-f(x))/(x+h-x) 那么在计算机系统内 不可能逼近无穷小, h最小只能为1. 那么导数公式约等于f'(x)=(f(x+1)-f(x))/1
  也就是[ f'(x)=f(x)-f(x-1) ]
  二阶导数那就是 f'(f'(x))=(f(x)-f(x-1))-(f(x-1)-f(x-2))= f(x)-2f(x-1)+f(x-2)
  那也可以理解为 f'(f'(x))=f(x+1)-2f(x)+f(x-1)

  二维公式则为 f'(f'(x,y))= -4 f(x, y) + f(x-1, y) + f(x+1, y) + f(x, y-1) + f(x, y+1)

  -----------------------
  |x-1,y-1|x,y-1|x+1,y-1|
  -----------------------
  |x-1,y  |x,y  |x+1,y  |
  -----------------------
  |x-1,y+1|x,y+1|x+1,y+1|
  ----------------------- 

  */
  function edgeDetect(input, output) {
    var inputData = input.data;
    var outputData = output.data;
    var width = input.width;
    var height = input.height;

    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        /*在Html5 Cavans 2DContext里面,point的RGBA格式是由一维数组表示,
         (x,y)点对应的信息是
         R=(y*width+x)*4+0
         G=(y*width+x)*4+1
         B=(y*width+x)*4+2
         A=(y*width+x)*4+3
        */
        var point = (y * width + x) * 4;
        var lightness;

        if (x === 0 || x >= width - 1 || y === 0 || y >= height - 1) {
          lightness = sample(inputData, point);
        } else {
          //对于3*3的区域,经验上被推荐最多的形式是 f=4*z5-(z2+z4+z6+z8)
          lightness =
            sample(inputData, point) * 4 - //坐标 x,y
            sample(inputData, point - width * 4) - //坐标 x,y-1
            sample(inputData, point - 4) - //坐标 x-1,y
            sample(inputData, point + 4) - //坐标 x+1,y
            sample(inputData, point + width * 4); //坐标 x,y+1
        }

        outputData[point + 1] = lightness;
      }
    }
  }

  function skinDetect(options, input, output) {
    var inputData = input.data;
    var outputData = output.data;
    var width = input.width;
    var height = input.height;

    for (var y = 0; y < heigth; y++) {
      for (var x = 0; x < width; x++) {
        var point = (y * width + x) * 4; //参考Ln205解释
        var lightness = cie(inputData[point], inputData[point + 1], inputData[point + 2]) / 255;
        var skin = skinColor(options, inputData[point], inputData[point + 1], inputData[point + 2]);
        var isSkinColor = skin > options.skinThreshold;
        var isSkinBrightness =
          lightness >= options.skinBrightnessMin &&
          lightness <= options.skinBrightnessMax;
        if (isSkinColor && isSkinBrightness) {
          outputData[point] =
            (skin - options.skinThreshold) *
            (255 / (1 - options.skinThreshold));
        } else {
          outputData[point] = 0;
        }
      }
    }
  }

  function saturationDetect(options, i, o) {
    var id = i.data;
    var od = o.data;
    var w = i.width;
    var h = i.height;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var p = (y * w + x) * 4;

        var lightness = cie(id[p], id[p + 1], id[p + 2]) / 255;
        var sat = saturation(id[p], id[p + 1], id[p + 2]);

        var acceptableSaturation = sat > options.saturationThreshold;
        var acceptableLightness =
          lightness >= options.saturationBrightnessMin &&
          lightness <= options.saturationBrightnessMax;
        if (acceptableLightness && acceptableSaturation) {
          od[p + 2] =
            (sat - options.saturationThreshold) *
            (255 / (1 - options.saturationThreshold));
        } else {
          od[p + 2] = 0;
        }
      }
    }
  }

  //Boost regions as specified by options (for example detected faces)
  //od这个数组n+0--skin n+1--edge n+2--saturation n+3--第三方人脸识别 或者 其他插件
  function applyBoosts(options, output) {
    if (!options.boost) return;
    var od = output.data;
    //这个理解有点晕,第一行的output中第三方插件分数清零?
    for (var i = 0; i < output.width; i += 4) {
      od[i + 3] = 0;
    }
    //循环插件的数量, 一般只有一个:人脸识别
    for (i = 0; i < options.boost.length; i++) {
      applyBoost(options.boost[i], options, output);
    }
  }

  function applyBoost(boost, options, output) {
    var od = output.data;
    var width = output.width;
    //~~ 两个波浪符 是取整的简写 等同于Math.trunc()
    //这个可读性很差 但是性能很好,考虑到这个图像函数是效率优先的.这个写法可以理解.
    //http://www.jstips.co/zh_cn/javascript/rounding-the-fast-way/
    var x0 = ~~boost.x; //人脸识别的左上角 x轴
    var x1 = ~~(boost.x + boost.width); //人脸识别右下角 x轴 
    var y0 = ~~boost.y; //人脸识别的左上角 y轴
    var y1 = ~~(boost.y + boost.height); //人脸识别右下角 y轴
    var weight = boost.weight * 255;
    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var i = (y * width + x) * 4;
        od[i + 3] += weight;
      }
    }
  }

  /*
  生成一大组crops,也就是各种长宽比例的矩形范围.
  */
  function generateCrops(options, width, height) {
    var results = [];
    var minDimension = min(width, height);
    var cropWidth = options.cropWidth || minDimension;//有option使用option设置的数值,没有则选minDimension
    var cropHeight = options.cropHeight || minDimension;
    for (
      var scale = options.maxScale; scale >= options.minScale; scale -= options.scaleStep
    ) {
      //取样因子就是step=8,所以每个crop与下个crop间距就是8
      for (var y = 0; y + cropHeight * scale <= height; y += options.step) {
        for (var x = 0; x + cropWidth * scale <= width; x += options.step) {
          results.push({
            x: x,
            y: y,
            width: cropWidth * scale,
            height: cropHeight * scale
          });
        }
      }
    }
    return results;
  }

  //给每个crop打分,这个矩形范围内所有采样点 按照detail;saturation;skin;boost ,各自累加.
  //然后按照各个系数的权重,给这个crop打总分.
  function score(options, output, crop) {
    var result = {
      detail: 0,
      saturation: 0,
      skin: 0,
      boost: 0,
      total: 0
    };

    var od = output.data;
    var downSample = options.scoreDownSample;
    var invDownSample = 1 / downSample;
    var outputHeightDownSample = output.height * downSample;
    var outputWidthDownSample = output.width * downSample;
    var outputWidth = output.width;

    for (var y = 0; y < outputHeightDownSample; y += downSample) {
      for (var x = 0; x < outputWidthDownSample; x += downSample) {
        var p =
          (~~(y * invDownSample) * outputWidth + ~~(x * invDownSample)) * 4;
        var i = importance(options, crop, x, y);
        var detail = od[p + 1] / 255;

        result.skin += od[p] / 255 * (detail + options.skinBias) * i;
        result.detail += detail * i;
        result.saturation +=
          od[p + 2] / 255 * (detail + options.saturationBias) * i;
        result.boost += od[p + 3] / 255 * i;
      }
    }

    result.total =
      (result.detail * options.detailWeight +
        result.skin * options.skinWeight +
        result.saturation * options.saturationWeight +
        result.boost * options.boostWeight) /
      (crop.width * crop.height);
    return result;
  }

  function importance(options, crop, x, y) {
    if (
      crop.x > x ||
      x >= crop.x + crop.width ||
      crop.y > y ||
      y >= crop.y + crop.height
    ) {
      return options.outsideImportance;
    }
    x = (x - crop.x) / crop.width;
    y = (y - crop.y) / crop.height;
    var px = abs(0.5 - x) * 2;
    var py = abs(0.5 - y) * 2;
    // Distance from edge
    var dx = Math.max(px - 1.0 + options.edgeRadius, 0);
    var dy = Math.max(py - 1.0 + options.edgeRadius, 0);
    var d = (dx * dx + dy * dy) * options.edgeWeight;
    var s = 1.41 - sqrt(px * px + py * py);
    if (options.ruleOfThirds) {
      s += Math.max(0, s + d + 0.5) * 1.2 * (thirds(px) + thirds(py));
    }
    return s + d;
  }
  smartcrop.importance = importance;

  /* Attach the author reply
    It's just an algorithm I made up on the spot.
    I tried a more scientific approach here: https://github.com/jwagner/smartcrop.js/tree/human-skin-color-clustering.
    In the end the results were similar enough for me not the change what was there and working.
    I hope that helps.
  */
  function skinColor(options, r, g, b) {
    var mag = sqrt(r * r + g * g + b * b);
    var rd = r / mag - options.skinColor[0];
    var gd = g / mag - options.skinColor[1];
    var bd = b / mag - options.skinColor[2];
    var d = sqrt(rd * rd + gd * gd + bd * bd);
    return 1 - d;
  }

  function analyse(options, input) {
    var result = {};
    var output = new ImgData(input.width, input.height);

    edgeDetect(input, output);
    skinDetect(options, input, output);
    saturationDetect(options, input, output);
    applyBoosts(options, output);

    var scoreOutput = downSample(output, options.scoreDownSample);

    var topScore = -Infinity;
    var topCrop = null;
    var crops = generateCrops(options, input.width, input.height);

    //循环所有可能的截图区域,获得最高分的区域,和最高分.
    for (var i = 0, iLen = crops.length; i < iLen; i++) {
      var crop = crops[i];
      crop.score = score(options, scoreOutput, crop);
      if (crop.score.total > topScore) {
        topCrop = crop;
        topScore = crop.score.total;
      }
    }

    result.topCrop = topCrop;

    if (options.debug && topCrop) {
      result.crops = crops;
      result.debugOutput = output;
      result.debugOptions = options;
      // Create a copy which will not be adjusted by the post scaling of smartcrop.crop
      result.debugTopCrop = extend({}, result.topCrop);
    }
    return result;
  }

  function ImgData(width, height, data) {
    this.width = width;
    this.height = height;
    if (data) {
      this.data = new Uint8ClampedArray(data);
    } else {
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  }
  smartcrop.ImgData = ImgData;

  /*
  降采样,即采样点减少.对于一幅N*M的图像来说,如果采样系数为k(这里为8),则是在每行每列每隔k个点去一个点组成图像.
  降采样很容易实现.实现的算法我还没找到对应的文档.
  */
  function downSample(input, factor) {
    var idata = input.data;
    var iwidth = input.width;
    var width = Math.floor(input.width / factor);
    var height = Math.floor(input.height / factor);
    var output = new ImgData(width, height);
    var data = output.data;
    var ifactor2 = 1 / (factor * factor);
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var i = (y * width + x) * 4;

        var r = 0;
        var g = 0;
        var b = 0;
        var a = 0;

        var mr = 0;
        var mg = 0;

        for (var v = 0; v < factor; v++) {
          for (var u = 0; u < factor; u++) {
            var j = ((y * factor + v) * iwidth + (x * factor + u)) * 4;
            r += idata[j];
            g += idata[j + 1];
            b += idata[j + 2];
            a += idata[j + 3];
            mr = Math.max(mr, idata[j]);
            mg = Math.max(mg, idata[j + 1]);
            // unused
            // mb = Math.max(mb, idata[j + 2]);
          }
        }
        // this is some funky magic to preserve detail a bit more for
        // skin (r) and detail (g). Saturation (b) does not get this boost.
        data[i] = r * ifactor2 * 0.5 + mr * 0.5;
        data[i + 1] = g * ifactor2 * 0.7 + mg * 0.3;
        data[i + 2] = b * ifactor2;
        data[i + 3] = a * ifactor2;
      }
    }
    return output;
  }
  smartcrop._downSample = downSample;

  function defaultCanvasFactory(w, h) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function canvasImageOperations(canvasFactory) {
    return {
      // Takes imageInput as argument
      // returns an object which has at least
      // {width: n, height: n}
      open: function(image) {
        // Work around images scaled in css by drawing them onto a canvas
        var w = image.naturalWidth || image.width;
        var h = image.naturalHeight || image.height;
        var c = canvasFactory(w, h);
        var ctx = c.getContext('2d');
        if (
          image.naturalWidth &&
          (image.naturalWidth != image.width ||
            image.naturalHeight != image.height)
        ) {
          c.width = image.naturalWidth;
          c.height = image.naturalHeight;
        } else {
          c.width = image.width;
          c.height = image.height;
        }
        ctx.drawImage(image, 0, 0);
        return smartcrop.Promise.resolve(c);
      },
      // Takes an image (as returned by open), and changes it's size by resampling
      resample: function(image, width, height) {
        return Promise.resolve(image).then(function(image) {
          var c = canvasFactory(~~width, ~~height);
          var ctx = c.getContext('2d');

          //ctx.drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);
          //sx 需要绘制到目标上下文中的，源图像的矩形选择框的左上角 X 坐标。
          //sy 需要绘制到目标上下文中的，源图像的矩形选择框的左上角 Y 坐标。
          //sWidth 需要绘制到目标上下文中的，源图像的矩形选择框的宽度。如果不说明，整个矩形从坐标的sx和sy开始，到图像的右下角结束。
          //sHeight 需要绘制到目标上下文中的，源图像的矩形选择框的高度。
          //dx 目标画布的左上角在目标canvas上 X 轴的位置。
          //dy 目标画布的左上角在目标canvas上 Y 轴的位置。
          //dWidth 在目标画布上绘制图像的宽度。 允许对绘制的图像进行缩放。 如果不说明， 在绘制时图片宽度不会缩放。
          //dHeight 在目标画布上绘制图像的高度。 允许对绘制的图像进行缩放。 如果不说明， 在绘制时图片高度不会缩放。
          ctx.drawImage(
            image,
            0,
            0,
            image.width,
            image.height,
            0,
            0,
            c.width,
            c.height
          );
          return smartcrop.Promise.resolve(c);
        });
      },
      getData: function(image) {
        //Uint8ClampedArray Image每个点x有4个信息RGBA [x+0],[x+1],[x+2],[x+3],用一维数组存储读写效率高.
        return Promise.resolve(image).then(function(c) {
          var ctx = c.getContext('2d');
          var id = ctx.getImageData(0, 0, c.width, c.height);
          return new ImgData(c.width, c.height, id.data);
        });
      }
    };
  }
  smartcrop._canvasImageOperations = canvasImageOperations;

  // Aliases and helpers
  var min = Math.min;
  var max = Math.max;
  var abs = Math.abs;
  var sqrt = Math.sqrt;

  function extend(o) {
    for (var i = 1, iLen = arguments.length; i < iLen; i++) {
      var arg = arguments[i];
      if (arg) {
        for (var name in arg) {
          o[name] = arg[name];
        }
      }
    }
    return o;
  }

  // Gets value in the range of [0, 1] where 0 is the center of the pictures
  // returns weight of rule of thirds [0, 1]
  function thirds(x) {
    x = (((x - 1 / 3 + 1.0) % 2.0) * 0.5 - 0.5) * 16;
    return Math.max(1.0 - x * x, 0.0);
  }

  function cie(r, g, b) {
    return 0.5126 * b + 0.7152 * g + 0.0722 * r;
  }

  function sample(id, p) {
    return cie(id[p], id[p + 1], id[p + 2]);
  }

  function saturation(r, g, b) {
    var maximum = max(r / 255, g / 255, b / 255);
    var minumum = min(r / 255, g / 255, b / 255);

    if (maximum === minumum) {
      return 0;
    }

    var l = (maximum + minumum) / 2;
    var d = maximum - minumum;

    return l > 0.5 ? d / (2 - maximum - minumum) : d / (maximum + minumum);
  }

  // Amd
  if (typeof define !== 'undefined' && define.amd)
    define(function() {
      return smartcrop;
    });
  // Common js
  if (typeof exports !== 'undefined') exports.smartcrop = smartcrop;
  else if (typeof navigator !== 'undefined')
    // Browser
    window.SmartCrop = window.smartcrop = smartcrop;
  // Nodejs
  if (typeof module !== 'undefined') {
    module.exports = smartcrop;
  }
})();