const QvacForgePlugin = require('@qvac/sdk/electron-forge')

/**
 * Only what the app runs is packaged: build/ (the bundled main process,
 * preload, page and tray icon), the production node_modules, and the QVAC
 * worker bundle the plugin writes to qvac/. Models ship apart, as a signed
 * model pack. Source maps stay behind.
 *
 * The QVAC plugin turns asar off (the Bare worker cannot read from it), so
 * the native modules (sharp, @napi-rs/canvas, the QVAC add-ons) load from
 * plain files and need no unpacking. Signing is done after packaging by
 * scripts/macos-sign.ts, inside out, with electron/entitlements.plist.
 */
const KEEP = ['/package.json', '/build', '/node_modules', '/qvac', '/qvac.config.json']

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
  packagerConfig: {
    name: 'Offline Field Assistant',
    executableName: 'offline-field-assistant',
    appBundleId: 'org.offlinefieldassistant.app',
    appCategoryType: 'public.app-category.medical',
    ignore: (file) =>
      (file !== '' && !KEEP.some((k) => file === k || file.startsWith(`${k}/`))) ||
      (file.startsWith('/build/') && file.endsWith('.map')) ||
      // Links to dev tools that pruning removes; strict signature checks refuse dangling links.
      file === '/node_modules/.bin' || file.startsWith('/node_modules/.bin/'),
    extendInfo: {
      // Menu-bar (tray) app: no Dock icon.
      LSUIElement: true,
      NSMicrophoneUsageDescription: 'Push-to-talk: the app turns speech into text and translates it, on this Mac only.',
      NSCameraUsageDescription: 'Point-the-camera translate: the app reads printed text and translates it, on this Mac only.'
    }
  },
  makers: [],
  plugins: [new QvacForgePlugin({ configPath: 'qvac.config.json' })]
}
