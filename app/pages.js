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
