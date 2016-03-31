/*
Copyright (c) 2015 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

'use strict';

// Include Gulp & tools we'll use
var gulp = require('gulp');
var $ = require('gulp-load-plugins')();
var del = require('del');
var runSequence = require('run-sequence');
var browserSync = require('browser-sync');
var reload = browserSync.reload;
var merge = require('merge-stream');
var path = require('path');
var fs = require('fs');
var glob = require('glob-all');
var historyApiFallback = require('connect-history-api-fallback');
var packageJson = require('./package.json');
var crypto = require('crypto');
var console = require("gulp-util");
var Manifest = require('http2-push-manifest/lib/manifest');
var ensureFiles = require('./tasks/ensure-files.js');

$.cache.clear();
$.cache.clearAll();

var AUTOPREFIXER_BROWSERS = [
  'ie >= 10',
  'ie_mob >= 10',
  'ff >= 30',
  'chrome >= 34',
  'safari >= 7',
  'opera >= 23',
  'ios >= 7',
  'android >= 4.4',
  'bb >= 10'
];

var DIST = 'static';

var dist = function(subpath) {
  return !subpath ? DIST : path.join(DIST, subpath);
};

var styleTask = function(stylesPath, srcs) {
  return gulp.src(srcs.map(function(src) {
      return path.join('app', stylesPath, src);
    }))
    .pipe($.changed(stylesPath, {extension: '.css'}))
    .pipe($.autoprefixer(AUTOPREFIXER_BROWSERS))
    .pipe(gulp.dest('.tmp/' + stylesPath))
    .pipe($.minifyCss())
    .pipe(gulp.dest(dist(stylesPath)))
    .pipe($.size({title: stylesPath}));
};

var imageOptimizeTask = function(src, dest) {
  return gulp.src(src)
    .pipe($.imagemin({
      progressive: true,
      interlaced: true
    }))
    .pipe(gulp.dest(dest))
    .pipe($.size({title: 'images'}));
};

var optimizeHtmlTask = function(src, dest) {
  var assets = $.useref.assets({
    searchPath: ['.tmp', 'app']
  });

  return gulp.src(src)
    .pipe(assets)
    // Concatenate and minify JavaScript
    .pipe($.if('*.js', $.uglify({
      preserveComments: 'some'
    })))
    // Concatenate and minify styles
    // In case you are still using useref build blocks
    .pipe($.if('*.css', $.minifyCss()))
    .pipe(assets.restore())
    .pipe($.useref())
    // Minify any HTML
    .pipe($.if('*.html', $.minifyHtml({
      quotes: true,
      empty: true,
      spare: true
    })))
    // Output files
    .pipe(gulp.dest(dest))
    .pipe($.size({
      title: 'html'
    }));
};

// Compile and automatically prefix stylesheets
gulp.task('styles', function() {
  return styleTask('styles', ['**/*.css']);
});

gulp.task('elements', function() {
  return styleTask('elements', ['**/*.css']);
});

// Ensure that we are not missing required files for the project
// "dot" files are specifically tricky due to them being hidden on
// some systems.
gulp.task('ensureFiles', function(cb) {
  var requiredFiles = ['.jscsrc', '.jshintrc', '.bowerrc'];

  ensureFiles(requiredFiles.map(function(p) {
    return path.join(__dirname, p);
  }), cb);
});

// Lint JavaScript
gulp.task('lint', ['ensureFiles'], function() {
  return gulp.src([
      'app/scripts/**/*.js',
      'app/elements/**/*.js',
      'app/elements/**/*.html',
      'gulpfile.js'
    ])
    .pipe(reload({
      stream: true,
      once: true
    }))

  // JSCS has not yet a extract option
  .pipe($.if('*.html', $.htmlExtract({strip: true})))
  .pipe($.jshint())
  .pipe($.jscs())
  .pipe($.jscsStylish.combineWithHintResults())
  .pipe($.jshint.reporter('jshint-stylish'))
  .pipe($.if(!browserSync.active, $.jshint.reporter('fail')));
});

// Optimize images
gulp.task('images', function() {
  return imageOptimizeTask('app/images/**/*', dist('images'));
});

// Copy all files at the root level (app)
gulp.task('copy', function() {
  var app = gulp.src([
    'app/*',
    '!app/test',
    '!app/elements',
    '!app/scripts',
    '!bower_components',
    '!app/cache-config.json',
    '!**/.DS_Store'
  ], {
    dot: true
  }).pipe(gulp.dest(dist()));

  // Copy over only the bower_components we need
  // These are things which cannot be vulcanized
  var bower = gulp.src([
    'bower_components/**/*'
    ]).pipe(gulp.dest(dist('bower_components')));

  var elements = gulp.src(['app/elements/**/*.html'])
    .pipe(gulp.dest(dist('elements')));

  var scripts = gulp.src(['app/scripts/*.js'])
    .pipe(gulp.dest(dist('scripts')));

  return merge(app, bower, elements, scripts)
    .pipe($.size({
      title: 'copy'
    }));
});

// Copy web fonts to dist
gulp.task('fonts', function() {
  return gulp.src(['app/fonts/**'])
    .pipe(gulp.dest(dist('fonts')))
    .pipe($.size({
      title: 'fonts'
    }));
});

// Scan your HTML for assets & optimize them
gulp.task('html', function() {
  return optimizeHtmlTask(
    ['app/**/*.html', '!app/{elements,test,bower_components}/**/*.html'],
    dist());
});

var ensurePath = function(file) {
  // Make a path if one wasn't given. e.g. basic.html -> ./basic.html
  return (file.indexOf(path.sep) === -1) ? `.${path.sep}${file}` : file;
};

gulp.task('push-manifest', function(done) {
  let dir = dist();
  let result = {};

  let src = ['index.html'];
  let manifestName = 'push_manifest.json';

  function processFile(file, singleFile) {
    let f = ensurePath(file);
    let basePath = f.slice(0, f.lastIndexOf(path.sep))
    let inputPath = f.slice(f.lastIndexOf(path.sep) + 1);

    let manifest = new Manifest({basePath, inputPath, name: manifestName });
    return manifest.generate().then(output => {
      if (singleFile)
        manifest.write(output.file);
      else
        result[inputPath] = output.file;
    });
  }

  glob(src, {cwd: dir}, (error, files) => {
    let singleFile = files.length < 2;
    return Promise.all(files.map(file => processFile(path.join(dir, file), singleFile)))
    .then(() => {
      if (!singleFile) {
        let manifest = new Manifest({name: manifestName})
        manifest.write(result);
      }
      done();
    });
  });
});

gulp.task('cache-config', function(done) {
  var dir = dist();
  var config = {
    cacheId: packageJson.name || path.basename(__dirname),
    disabled: false
  };

  let src = ['index.html', '{elements,scripts,styles}/**/*.*'];
  let manifestName = 'cache-config.json';

  function processFile(file) {
    let f = ensurePath(file);
    let basePath = f.slice(0, f.lastIndexOf(path.sep))
    let inputPath = f.slice(f.lastIndexOf(path.sep) + 1);

    let manifest = new Manifest({basePath, inputPath, name: manifestName });
    return manifest.generate().then(output => {
      config.precache = output.urls.map((url) => {
        return url.startsWith('/') ? url.slice(1) : url;
      });
    });
  }

  glob(src, {cwd: dir}, (error, files) => {
    return Promise.all(files.map(file => processFile(path.join(dir, file))))
    .then(() => {
      config.precache.push('./');

      let md5 = crypto.createHash('md5');
      md5.update(JSON.stringify(config.precache));
      config.precacheFingerprint = md5.digest('hex');

      var configPath = path.join(dir, manifestName);
      return new Promise(function(resolve) {
        fs.writeFile(configPath, JSON.stringify(config), resolve);
      })
      .then(() => done());
    });
  });
});

// Clean output directory
gulp.task('clean', function() {
  return del(['.tmp', dist()]);
});

// Watch files for changes & reload
gulp.task('serve', ['styles', 'elements', 'images'], function () {
  browserSync({
    port: 5000,
    notify: false,
    logPrefix: 'WeNEED',
    snippetOptions: {
      rule: {
        match: '<span id="browser-sync-binding"></span>',
        fn: function (snippet) {
          return snippet;
        }
      }
    },
    // Run as an https by uncommenting 'https: true'
    // Note: this uses an unsigned certificate which on first access
    //       will present a certificate warning in the browser.
    // https: true,
    server: {
      baseDir: ['.tmp', 'app'],
      middleware: function(req, res, next) {
        req.url = req.url.replace(".png", "@1.png");
        //console.log(req.url);
        return next();
      },
      routes: {
        '/bower_components': 'bower_components'
      }
    }
  });

  gulp.watch(['app/**/*.html'], reload);
  gulp.watch(['app/styles/**/*.css'], ['styles', reload]);
  gulp.watch(['app/elements/**/*.css'], ['elements', reload]);
  //gulp.watch(['app/{scripts,elements}/**/{*.js,*.html}'], [lint']);
  gulp.watch(['app/images/**/*'], reload);
});

// Build and serve the output from the dist build
gulp.task('serve:dist', ['default'], function() {
  browserSync({
    port: 5001,
    notify: false,
    logPrefix: 'WeNEED',
    snippetOptions: {
      rule: {
        match: '<span id="browser-sync-binding"></span>',
        fn: function(snippet) {
          return snippet;
        }
      }
    },
    // Run as an https by uncommenting 'https: true'
    // Note: this uses an unsigned certificate which on first access
    //       will present a certificate warning in the browser.
    // https: true,
    server: dist(),
    middleware: [historyApiFallback()]
  });
});

// Build production files, the default task
gulp.task('default', ['clean'], function(cb) {
  runSequence(
    ['copy', 'styles'],
    'elements',
    [//'lint',
    'images', 'fonts', 'html'],
    'push-manifest',
    'cache-config',
    cb);
});

// Load custom tasks from the `tasks` directory
try {
  require('require-dir')('tasks');
} catch (err) {}
