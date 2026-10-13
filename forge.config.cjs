const QvacForgePlugin = require('@qvac/sdk/electron-forge')

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
  packagerConfig: {
    name: 'Offline Field Assistant',
    executableName: 'offline-field-assistant',
    appBundleId: 'org.offlinefieldassistant.app',
    // Models ship as a separate signed model pack, never inside the app.
    ignore: [/^\/models\//, /^\/eval\//, /^\/tests\//, /^\/scripts\//, /^\/out\//, /\.docx$/, /^\/\.git/]
  },
  makers: [{ name: '@electron-forge/maker-zip', platforms: ['darwin'] }],
  plugins: [new QvacForgePlugin({ configPath: 'qvac.config.json' })]
}
