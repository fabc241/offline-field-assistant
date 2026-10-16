// Runs before the first paint so the window never flashes the wrong theme.
// The app's own code (app.js) keeps it in step afterwards.
;(function () {
  var pref = 'system'
  var size = 'normal'
  try {
    pref = localStorage.getItem('ofa.theme') || 'system'
    size = localStorage.getItem('ofa.textSize') || 'normal'
  } catch (e) {}
  var dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.text = size
})()
