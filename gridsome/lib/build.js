const fs = require('fs-extra')
const hirestime = require('hirestime')
const sysinfo = require('./utils/sysinfo')
const executeQueries = require('./app/build/executeQueries')
const createRenderQueue = require('./app/build/createRenderQueue')
const { logAllWarnings } = require('./utils/deprecate')
const { log, info, writeLine } = require('./utils/log')

module.exports = async (context, args) => {
  process.env.NODE_ENV = 'production'
  process.env.GRIDSOME_MODE = 'static'

  const buildTime = hirestime()
  const createApp = require('./app')
  const app = await createApp(context, { args })
  const { config } = app

  await app.plugins.run('beforeBuild', { context, config })

  await fs.emptyDir(config.outputDir)

  const stats = await runWebpack(app)
  const hashString = config.cacheBusting ? stats.hash : 'gridsome'

  const queue = createRenderQueue(app)
  const redirects = app.hooks.redirects.call([], queue)

  await executeQueries(queue, app, hashString)
  await renderHTML(queue, app, hashString, app.config)
  await processFiles(app.assets.files)
  await processImages(app.assets.images, app.config)

  // copy static files
  if (fs.existsSync(config.staticDir)) {
    await fs.copy(config.staticDir, config.outputDir, {
      dereference: true
    })
  }

  await app.plugins.run('afterBuild', () => ({ context, config, queue, redirects }))

  // clean up
  await fs.remove(config.manifestsDir)

  log()
  logAllWarnings(app.context)
  log(`  Done in ${buildTime(hirestime.S)}s`)
  log()

  return app
}

async function runWebpack (app) {
  const compileTime = hirestime()
  const compileAssets = require('./webpack/compileAssets')
  const { removeStylesJsChunk } = require('./webpack/utils')

  if (!process.stdout.isTTY) {
    info(`Compiling assets...`)
  }

  const stats = await compileAssets(app)

  if (app.config.css.split !== true) {
    await removeStylesJsChunk(stats, app.config.outputDir)
  }

  info(`Compile assets - ${compileTime(hirestime.S)}s`)

  return stats
}

async function renderHTML (renderQueue, app, hash, config) {
  const { createWorker } = require('./workers')
  const timer = hirestime()
  const concurrency = config.renderConcurrency || sysinfo.cpus.physical
  const worker = createWorker('html-writer', { numWorkers: concurrency })
  const { htmlTemplate, clientManifestPath, serverBundlePath, prefetch, preload } = app.config
  
  let done = 0
  const total = renderQueue.length
  const progress = (done,total) => writeLine(`${((done / total) * 100).toFixed(2)}% - Processing pages... (${done} / ${total} pages)`)

  try {
    progress(done, total)
    
    await parallel(renderQueue, async (page) => {
      await worker.render({
        hash,
        page,
        htmlTemplate,
        clientManifestPath,
        serverBundlePath,
        prefetch,
        preload
      })
      progress(done, total)
    }, concurrency)

  } catch (err) {
    throw err
  } finally {
    worker.end()
  }

  info(`Render HTML (${renderQueue.length} files) - ${timer(hirestime.S)}s`)
}

async function processFiles (files) {
  const timer = hirestime()
  const totalFiles = files.queue.length

  for (const file of files.queue) {
    await fs.copy(file.filePath, file.destPath)
  }

  info(`Process files (${totalFiles} files) - ${timer(hirestime.S)}s`)
}

function parallel(items, handler, concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('concurrency must be a positive integer greater than 0');
  if (items.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const results = [];
    let i = 0;

    const next = (result) => {
      results.push(result);
      if (i < items.length) {
        try {
          handler(items[i++]).then(next).catch(reject);
        } catch (err) { reject(err); }
      }
      else if (results.length === items.length) resolve(results);
    };

    for (let x = 0; x < Math.min(concurrency, items.length); x++) {
      try {
        handler(items[i++]).then(next).catch(reject);
      } catch (err) { reject(err); break; }
    }
  });
}

async function processImages (images, config) {
  const { createWorker } = require('./workers')
  const timer = hirestime()

  const concurrency = config.imageConcurrency || sysinfo.cpus.physical
  const worker = createWorker('image-processor', { numWorkers: concurrency })
  const total = images.queue.length
  let done = 0

  log(`Processing ${total} images... (concurrency: ${concurrency})`)

  const progress = (done,total) => writeLine(`${((done / total) * 100).toFixed(2)}% - Processing images... (${done} / ${total} images)`)
  try {
    progress(done, total)

    await parallel(images.queue, async (image) => {
      await worker.process({
        outputDir: config.outputDir,
        context: config.context,
        cacheDir: config.imageCacheDir,
        imagesConfig: config.images,
        image
      })
      progress(done++, total)
    }, concurrency)

  } catch (err) {
    throw err
  }
  finally {
    worker.end()
  }

  writeLine(`Images processed! (${done} / ${total} images) - ${timer(hirestime.S)}s\n`)
}
