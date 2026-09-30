/* Homepage-only: renders the "Where visitors click first" widget
   from live data served by /api/attention (backed by PostHog). */
(function () {
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function render(data) {
    var el = document.getElementById('attentionWidget');
    if (!el) return;

    if (!data || !data.ready || !data.items || !data.items.length) {
      el.innerHTML = '<p class="attention-empty">Still collecting data on this page. Check back soon.</p>';
      return;
    }

    var rows = data.items.map(function (item) {
      return (
        '<div class="attention-row">' +
        '<span class="attention-label">' + escapeHtml(item.label) + '</span>' +
        '<span class="attention-track"><span class="attention-fill" style="width:' + item.pct + '%"></span></span>' +
        '<span class="attention-pct">' + item.pct + '%</span>' +
        '</div>'
      );
    }).join('');

    var updated = '';
    if (data.updated) {
      var d = new Date(data.updated);
      if (!isNaN(d.getTime())) {
        updated = ' \u00b7 updated ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }
    }

    el.innerHTML =
      rows +
      '<p class="attention-foot">Based on ' + data.total + ' visitor session' + (data.total === 1 ? '' : 's') + updated + '</p>';
  }

  function load() {
    fetch('/api/attention')
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () { render(null); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
