(() => {
  // Allow embedded timelines/cards inside iframes on other sites.
  if (window.top !== window.self) {
    return;
  }

  const host = window.location.hostname.toLowerCase();
  const trackedHosts = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
  if (!trackedHosts.has(host)) {
    return;
  }

  chrome.runtime.sendMessage({ type: "SHOULD_BLOCK" }, (response) => {
    if (chrome.runtime.lastError) {
      return;
    }

    if (response && response.blocked) {
      window.location.replace(chrome.runtime.getURL("blocked.html"));
    }
  });
})();
