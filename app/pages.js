// Info pages: "Back" returns to the board. When the page was opened from the app,
// going back in history keeps the board where it was; otherwise it loads the app.
(function () {
  var back = document.querySelector(".page-top .back");
  if (!back) return;
  back.addEventListener("click", function (e) {
    var ref = document.referrer, app = new URL("./", location.href).href;
    if (history.length > 1 && (ref === app || ref === app + "index.html")) { e.preventDefault(); history.back(); }
  });
})();

// Open the FAQ answer a link points at, e.g. support.html#sync.
(function () {
  function openTarget() {
    var t = location.hash && document.getElementById(location.hash.slice(1));
    if (t && t.tagName === "DETAILS") t.open = true;
  }
  openTarget();
  window.addEventListener("hashchange", openTarget);
})();

// Support: Send feedback fills in the device, plus the live version and build once version.json loads.
(function () {
  var btn = document.getElementById("feedbackBtn");
  if (!btn || !window.fetch) return;
  var ua = navigator.userAgent, device =
    /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad" :
    /iPhone|iPod/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" :
    /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "Unknown device";
  var installed = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  var deviceLine = "Device: " + device + ", " + (installed ? "installed app" : "in the browser") + "\n";
  btn.href += "&body=" + encodeURIComponent("\n\n\n---\n" + deviceLine);
  fetch("version.json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
    if (!v || !v.build) return;
    var label = (v.version ? v.version + ", " : "") + "build " + v.build;
    var body = "\n\n\n---\n" + (v.version ? "Version " + v.version + " · " : "") + "Build " + v.build + " (" + v.sha + ")\n" + deviceLine;
    btn.href = "mailto:hello@tweetingbirds.com?subject=" + encodeURIComponent("Now or Later feedback (" + label + ")") + "&body=" + encodeURIComponent(body);
  }).catch(function () {});
})();
