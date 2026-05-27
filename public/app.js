var token = localStorage.getItem('mimo2api_token');

function API(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers || {}, { 'Content-Type': 'application/json' });
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  return fetch(path, opts).then(function(r) {
    return r.json().then(function(data) {
      if (!r.ok) throw new Error(data.error || 'Request failed');
      return data;
    });
  });
}

function toast(msg, type) {
  type = type || 'success';
  var el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function() { el.remove(); }, 3500);
}

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function maskKey(k) {
  return k.slice(0, 14) + '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + k.slice(-4);
}

function timeAgo(d) {
  if (!d) return '\u2014';
  var s = Math.floor((Date.now() - new Date(d + 'Z').getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function copyText(t) {
  navigator.clipboard.writeText(t).then(function() { toast('Copied!'); }).catch(function() {});
}

// ── Auth ──

function doLogin() {
  var pw = document.getElementById('loginPassword').value;
  API('/admin/login', { method: 'POST', body: JSON.stringify({ password: pw }) })
    .then(function(data) {
      token = data.token;
      localStorage.setItem('mimo2api_token', token);
      document.getElementById('loginOverlay').classList.add('hidden');
      loadAll();
    })
    .catch(function(e) {
      document.getElementById('loginError').textContent = e.message;
    });
}

function logout() {
  token = null;
  localStorage.removeItem('mimo2api_token');
  location.reload();
}

function checkAuth() {
  if (token) {
    document.getElementById('loginOverlay').classList.add('hidden');
    loadAll();
  }
}

// ── Tabs ──

var tabLinks = document.querySelectorAll('.sidebar a[data-tab]');
for (var i = 0; i < tabLinks.length; i++) {
  (function(a) {
    a.addEventListener('click', function(e) {
      e.preventDefault();
      var all = document.querySelectorAll('.sidebar a[data-tab]');
      for (var j = 0; j < all.length; j++) all[j].classList.remove('active');
      a.classList.add('active');
      var tabs = document.querySelectorAll('.tab-content');
      for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('active');
      document.getElementById('tab-' + a.getAttribute('data-tab')).classList.add('active');
      if (a.getAttribute('data-tab') === 'sessions') loadSessions();
    });
  })(tabLinks[i]);
}

// ── Load Data ──

function loadAll() {
  document.getElementById('baseUrl').textContent = location.origin;
  loadAccounts();
  loadKeys();
  loadModels();
  loadSessions();
}

function loadAccounts() {
  API('/admin/accounts').then(function(rows) {
    var active = rows.filter(function(r) { return r.active; });
    document.getElementById('statAccounts').textContent = active.length;
    document.getElementById('statRequests').textContent = rows.reduce(function(s, r) { return s + (r.request_count || 0); }, 0);
    var tbody = document.getElementById('accountsTable');
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:24px;">No accounts yet. Paste a cURL above.</td></tr>';
      return;
    }
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html += '<tr>';
      html += '<td>' + esc(r.label || '\u2014') + '</td>';
      html += '<td class="mono">' + esc(r.user_id) + '</td>';
      html += '<td><span class="badge ' + (r.active ? 'badge-green' : 'badge-red') + '">' + (r.active ? 'Active' : 'Disabled') + '</span></td>';
      html += '<td>' + (r.request_count || 0) + '</td>';
      html += '<td style="color:var(--text2)">' + (r.last_used ? timeAgo(r.last_used) : 'Never') + '</td>';
      html += '<td class="actions">';
      html += '<button class="btn btn-toggle btn-sm" data-action="toggle-account" data-id="' + r.id + '" data-active="' + (r.active ? 0 : 1) + '">' + (r.active ? 'Disable' : 'Enable') + '</button>';
      html += '<button class="btn btn-danger btn-sm" data-action="delete-account" data-id="' + r.id + '">Delete</button>';
      html += '</td></tr>';
    }
    tbody.innerHTML = html;
  }).catch(function(e) { console.error('loadAccounts:', e); });
}

function loadKeys() {
  API('/admin/keys').then(function(rows) {
    document.getElementById('statKeys').textContent = rows.filter(function(r) { return r.active; }).length;
    var tbody = document.getElementById('keysTable');
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:24px;">No API keys. Generate one above.</td></tr>';
      return;
    }
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html += '<tr>';
      html += '<td>' + esc(r.name || '\u2014') + '</td>';
      html += '<td class="mono" style="cursor:pointer" data-action="copy" data-value="' + esc(r.key) + '">' + maskKey(r.key) + '</td>';
      html += '<td><span class="badge ' + (r.active ? 'badge-green' : 'badge-red') + '">' + (r.active ? 'Active' : 'Disabled') + '</span></td>';
      html += '<td>' + (r.request_count || 0) + '</td>';
      html += '<td style="color:var(--text2)">' + timeAgo(r.created_at) + '</td>';
      html += '<td class="actions">';
      html += '<button class="btn btn-toggle btn-sm" data-action="toggle-key" data-id="' + r.id + '" data-active="' + (r.active ? 0 : 1) + '">' + (r.active ? 'Disable' : 'Enable') + '</button>';
      html += '<button class="btn btn-danger btn-sm" data-action="delete-key" data-id="' + r.id + '">Delete</button>';
      html += '</td></tr>';
    }
    tbody.innerHTML = html;
  }).catch(function(e) { console.error('loadKeys:', e); });
}

function loadModels() {
  API('/admin/models').then(function(rows) {
    document.getElementById('statModels').textContent = rows.filter(function(r) { return r.active; }).length;
    var tbody = document.getElementById('modelsTable');
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:24px;">No models. Add one above.</td></tr>';
      return;
    }
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html += '<tr>';
      html += '<td class="mono">' + esc(r.model_id) + '</td>';
      html += '<td>' + esc(r.display_name || r.model_id) + '</td>';
      html += '<td><span class="badge ' + (r.active ? 'badge-green' : 'badge-red') + '">' + (r.active ? 'Listed' : 'Unlisted') + '</span></td>';
      html += '<td class="actions">';
      html += '<button class="btn btn-toggle btn-sm" data-action="toggle-model" data-id="' + r.id + '" data-active="' + (r.active ? 0 : 1) + '">' + (r.active ? 'Unlist' : 'List') + '</button>';
      html += '<button class="btn btn-danger btn-sm" data-action="delete-model" data-id="' + r.id + '">Delete</button>';
      html += '</td></tr>';
    }
    tbody.innerHTML = html;
  }).catch(function(e) { console.error('loadModels:', e); });
}

function loadSessions() {
  API('/admin/conversations').then(function(rows) {
    document.getElementById('statConversations').textContent = rows.length;
    var tbody = document.getElementById('sessionsTable');
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:24px;">No active sessions.</td></tr>';
      return;
    }
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html += '<tr>';
      html += '<td class="mono" title="' + esc(r.conv_key) + '">' + esc(r.conv_key.slice(0, 16)) + '\u2026</td>';
      html += '<td>' + esc(r.account_label || '?') + ' <span style="color:var(--text3)">(' + esc(r.user_id || '?') + ')</span></td>';
      html += '<td><span class="badge badge-blue">' + esc(r.model || '?') + '</span></td>';
      html += '<td>' + r.message_count + '</td>';
      html += '<td style="color:var(--text2)">' + timeAgo(r.last_used) + '</td>';
      html += '<td style="color:var(--text3)">' + timeAgo(r.created_at) + '</td>';
      html += '</tr>';
    }
    tbody.innerHTML = html;
  }).catch(function() {});
}

// ── Event delegation for dynamic buttons ──

document.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-action]');
  if (!btn) return;
  var action = btn.getAttribute('data-action');
  var id = btn.getAttribute('data-id');
  var active = btn.getAttribute('data-active');
  var value = btn.getAttribute('data-value');

  switch (action) {
    case 'toggle-account':
      API('/admin/accounts/' + id, { method: 'PATCH', body: JSON.stringify({ active: Number(active) === 1 }) }).then(loadAccounts);
      break;
    case 'delete-account':
      if (confirm('Delete this account? Related sessions will also be removed.')) {
        API('/admin/accounts/' + id, { method: 'DELETE' }).then(function() { toast('Deleted'); loadAccounts(); loadSessions(); });
      }
      break;
    case 'toggle-key':
      API('/admin/keys/' + id, { method: 'PATCH', body: JSON.stringify({ active: Number(active) === 1 }) }).then(loadKeys);
      break;
    case 'delete-key':
      if (confirm('Delete this API key?')) {
        API('/admin/keys/' + id, { method: 'DELETE' }).then(function() { toast('Deleted'); loadKeys(); });
      }
      break;
    case 'toggle-model':
      API('/admin/models/' + id, { method: 'PATCH', body: JSON.stringify({ active: Number(active) === 1 }) }).then(loadModels);
      break;
    case 'delete-model':
      if (confirm('Remove this model?')) {
        API('/admin/models/' + id, { method: 'DELETE' }).then(function() { toast('Deleted'); loadModels(); });
      }
      break;
    case 'copy':
      if (value) copyText(value);
      break;
  }
});

// ── Button bindings ──

document.getElementById('loginBtn').addEventListener('click', doLogin);

document.getElementById('loginPassword').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doLogin();
});

document.getElementById('logoutBtn').addEventListener('click', function(e) {
  e.preventDefault();
  logout();
});

document.getElementById('addAccountBtn').addEventListener('click', function() {
  var curl = document.getElementById('accountCurl').value;
  var label = document.getElementById('accountLabel').value;
  if (!curl.trim()) return toast('Paste a cURL command', 'error');
  API('/admin/accounts', { method: 'POST', body: JSON.stringify({ curl: curl, label: label }) })
    .then(function() {
      document.getElementById('accountCurl').value = '';
      document.getElementById('accountLabel').value = '';
      toast('Account added!');
      loadAccounts();
    })
    .catch(function(e) { toast(e.message, 'error'); });
});

document.getElementById('createKeyBtn').addEventListener('click', function() {
  var name = document.getElementById('keyName').value;
  API('/admin/keys', { method: 'POST', body: JSON.stringify({ name: name }) })
    .then(function(data) {
      document.getElementById('keyName').value = '';
      navigator.clipboard.writeText(data.key).catch(function() {});
      toast('Key created & copied!');
      loadKeys();
    })
    .catch(function(e) { toast(e.message, 'error'); });
});

document.getElementById('addModelBtn').addEventListener('click', function() {
  var model_id = document.getElementById('modelId').value.trim();
  var display_name = document.getElementById('modelName').value.trim();
  if (!model_id) return toast('Model ID required', 'error');
  API('/admin/models', { method: 'POST', body: JSON.stringify({ model_id: model_id, display_name: display_name }) })
    .then(function() {
      document.getElementById('modelId').value = '';
      document.getElementById('modelName').value = '';
      toast('Model added!');
      loadModels();
    })
    .catch(function(e) { toast(e.message, 'error'); });
});

document.getElementById('clearConvsBtn').addEventListener('click', function() {
  if (!confirm('Clear all tracked sessions?')) return;
  API('/admin/conversations', { method: 'DELETE' })
    .then(function() { toast('Sessions cleared'); loadSessions(); })
    .catch(function(e) { toast(e.message, 'error'); });
});

// ── Init ──

checkAuth();
