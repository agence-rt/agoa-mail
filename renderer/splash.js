(function () {
  "use strict";
  var status = document.getElementById("status"), bar = document.getElementById("bar"), fill = document.getElementById("fill");
  var v = new URLSearchParams(location.search).get("v");
  if (v) document.getElementById("ver").textContent = "v" + v;
  function show(s) {
    status.textContent = s.text || "";
    var checking = /^Recherche/.test(s.text || ""), downloading = typeof s.progress === "number";
    bar.classList.toggle("on", checking || downloading);
    bar.classList.toggle("idle", checking && !downloading);
    fill.style.width = downloading ? Math.max(2, Math.min(100, s.progress)) + "%" : "";
  }
  if (window.splash) window.splash.onStatus(show);
})();
