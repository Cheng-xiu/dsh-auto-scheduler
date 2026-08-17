window.__ModuleLoader__.load({
	id: "dsh-auto-scheduler",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var inject = [];
		var API_BASE = "/api/dsh-auto-scheduler";
		var POLL_MS = 30000;

		var schedules = [];
		var panelOpen = false;
		var disposed = false;
		var timers = [];
		var observers = [];
		var entryEl = null;
		var panelEl = null;

		function pad2(n) { return n < 10 ? "0" + n : String(n); }

		function toLocalInput(iso) {
			var d = new Date(iso);
			if (isNaN(d.getTime())) return "";
			return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
		}

		function fmtLocal(iso) {
			if (!iso) return "-";
			var d = new Date(iso);
			if (isNaN(d.getTime())) return "-";
			return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
		}

		function fromLocalInput(value) {
			if (!value) return null;
			var d = new Date(value);
			if (isNaN(d.getTime())) return null;
			return d.toISOString();
		}

		function systemTz() {
			try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; }
		}

		function shanghaiParts(now) {
			try {
				var parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
				var y = 0, m = 0, d = 0;
				for (var i = 0; i < parts.length; i++) {
					if (parts[i].type === "year") y = Number(parts[i].value);
					if (parts[i].type === "month") m = Number(parts[i].value);
					if (parts[i].type === "day") d = Number(parts[i].value);
				}
				return { y: y, m: m, d: d };
			} catch (e) { return null; }
		}

		// Beijing (UTC+8) valley windows expressed as UTC hour + duration ms.
		// 12:00-14:00 CST = 04:00-06:00 UTC; 18:00-09:00 CST = 10:00-01:00(+1d) UTC.
		function valleyWindow(startUtcHour, durationMs) {
			var now = Date.now();
			var parts = shanghaiParts(now);
			if (!parts) return null;
			var start = Date.UTC(parts.y, parts.m - 1, parts.d, startUtcHour, 0, 0, 0);
			while (start + durationMs <= now) start += 86400000;
			var startAt;
			if (now >= start) {
				startAt = Math.min(start + durationMs - 60000, Math.ceil(now / 60000) * 60000);
			} else {
				startAt = start;
			}
			return { startAt: startAt, stopAt: start + durationMs };
		}

		function escapeHtml(text) {
			return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
		}

		function statusText(s) {
			var map = { idle: "等待开始", running: "运行中", stopped: "已停止", missed: "已错过", error: "出错", done: "已完成" };
			return map[s.status] || s.status;
		}

		function statusClass(s) {
			if (s.status === "running") return "as-running";
			if (s.status === "error") return "as-error";
			return "as-idle";
		}

		function countdown(iso) {
			if (!iso) return "";
			var ms = Date.parse(iso) - Date.now();
			if (isNaN(ms)) return "";
			if (ms <= 0) return "已到期";
			var sec = Math.floor(ms / 1000);
			var d = Math.floor(sec / 86400);
			var h = Math.floor((sec % 86400) / 3600);
			var m = Math.floor((sec % 3600) / 60);
			var s2 = sec % 60;
			var out = "";
			if (d > 0) out += d + "天 ";
			if (h > 0 || d > 0) out += pad2(h) + ":";
			out += pad2(m) + ":" + pad2(s2);
			return out;
		}

		function modeText(s) { return s.mode === "silent" ? "静默" : "默认"; }

		// ---------- api ----------
		async function api(method, path, body) {
			var options = { method: method, headers: { "content-type": "application/json" } };
			if (body !== undefined) options.body = JSON.stringify(body);
			var resp = await fetch(API_BASE + path, options);
			var data = await resp.json().catch(function () { return null; });
			if (!resp.ok || !data || data.ok !== true) {
				throw new Error(data && data.error ? data.error : ("HTTP " + resp.status));
			}
			return data;
		}

		async function loadSchedules() {
			try {
				var data = await api("GET", "/schedules");
				schedules = data.schedules || [];
				renderList();
				clearError();
			} catch (e) {
				showError("加载失败: " + (e && e.message ? e.message : String(e)));
			}
		}

		function showError(msg) {
			var el = document.getElementById("as-error");
			if (el) { el.textContent = msg; el.style.display = "block"; }
		}

		function clearError() {
			var el = document.getElementById("as-error");
			if (el) { el.textContent = ""; el.style.display = "none"; }
		}

		// ---------- panel ----------
		function buildPanel() {
			if (panelEl) return;
			panelEl = document.createElement("div");
			panelEl.id = "dsh-autosched-panel";
			panelEl.innerHTML = "" +
				"<div class=\"as-head\"><div class=\"as-title\">自动工作 <span class=\"as-sub\">定时开始 / 停止</span></div>" +
				"<button class=\"as-close\" id=\"as-close\" type=\"button\">&times;</button></div>" +
				"<div class=\"as-note\">时间按本机时区显示（<span id=\"as-tz\"></span>），保存后内部转为 UTC；ds 谷峰时段为北京时间（UTC+8），已按本机时区换算填充。</div>" +
				"<div class=\"as-form\">" +
				"<label class=\"as-label\">工作目标</label>" +
				"<textarea id=\"as-goal\" rows=\"4\" placeholder=\"例如：修复 xxx 项目的构建错误并提交 PR\"></textarea>" +
				"<div class=\"as-row2\">" +
				"<div><label class=\"as-label\">模式</label><select id=\"as-mode\"><option value=\"default\">默认模式（可提问）</option><option value=\"silent\">静默模式（不提问，完成前不停）</option></select></div>" +
				"<div><label class=\"as-label\">重复</label><select id=\"as-repeat\"><option value=\"once\">仅一次</option><option value=\"daily\">每天</option></select></div>" +
				"</div>" +
				"<div class=\"as-row2\">" +
				"<div><label class=\"as-label\">开始时间（本机）</label><input type=\"datetime-local\" id=\"as-start\"></div>" +
				"<div><label class=\"as-label\">停止时间（本机）</label><input type=\"datetime-local\" id=\"as-stop\"></div>" +
				"</div>" +
				"<div class=\"as-presets\"><span class=\"as-preset-label\">ds 谷峰时段：</span>" +
				"<button class=\"as-btn as-btn-mini\" id=\"as-valley-noon\" type=\"button\">谷 12:00&ndash;14:00</button>" +
				"<button class=\"as-btn as-btn-mini\" id=\"as-valley-night\" type=\"button\">谷 18:00&ndash;次日 9:00</button></div>" +
				"<div class=\"as-warn\">静默模式 = danger-full-access 全权限无人值守执行，请只在信任的任务上使用。</div>" +
				"<div class=\"as-actions\">" +
				"<button class=\"as-btn as-btn-primary\" id=\"as-save\" type=\"button\">保存任务</button>" +
				"<button class=\"as-btn\" id=\"as-clear\" type=\"button\">清空表单</button>" +
				"</div>" +
				"<div id=\"as-error\" class=\"as-error\"></div>" +
				"</div>" +
				"<div class=\"as-list\" id=\"as-list\"></div>";
			document.body.appendChild(panelEl);
			var tzEl = document.getElementById("as-tz");
			if (tzEl) tzEl.textContent = systemTz();
			document.getElementById("as-close").addEventListener("click", function () { setOpen(false); });
			document.getElementById("as-save").addEventListener("click", saveForm);
			document.getElementById("as-clear").addEventListener("click", clearForm);
			document.getElementById("as-valley-noon").addEventListener("click", function () { fillValley(4, 2 * 3600000); });
			document.getElementById("as-valley-night").addEventListener("click", function () { fillValley(10, 15 * 3600000); });
			var list = document.getElementById("as-list");
			list.addEventListener("click", function (event) {
				var target = event.target;
				while (target && target !== list && !(target.getAttribute && target.getAttribute("data-act"))) target = target.parentElement;
				if (!target || target === list) return;
				var act = target.getAttribute("data-act");
				var id = target.getAttribute("data-id");
				if (act === "del") deleteSchedule(id);
				else if (act === "run") runNow(id);
				else if (act === "edit") editSchedule(id);
			});
			list.addEventListener("change", function (event) {
				var target = event.target;
				if (target && target.getAttribute && target.getAttribute("data-act") === "toggle") {
					toggleSchedule(target.getAttribute("data-id"), target.checked);
				}
			});
		}

		function setOpen(open) {
			panelOpen = open;
			if (panelEl) panelEl.classList.toggle("as-open", open);
			if (entryEl) {
				if (open) entryEl.setAttribute("data-active", "true");
				else entryEl.removeAttribute("data-active");
			}
		}

		function fillValley(startUtcHour, durationMs) {
			var w = valleyWindow(startUtcHour, durationMs);
			if (!w) { showError("无法计算谷峰时段"); return; }
			document.getElementById("as-start").value = toLocalInput(new Date(w.startAt).toISOString());
			document.getElementById("as-stop").value = toLocalInput(new Date(w.stopAt).toISOString());
			clearError();
		}

		function clearForm() {
			document.getElementById("as-goal").value = "";
			document.getElementById("as-start").value = "";
			document.getElementById("as-stop").value = "";
			document.getElementById("as-mode").value = "default";
			document.getElementById("as-repeat").value = "once";
			window.__asEditId = null;
			clearError();
		}

		async function saveForm() {
			var goal = document.getElementById("as-goal").value.trim();
			var start = fromLocalInput(document.getElementById("as-start").value);
			var stop = fromLocalInput(document.getElementById("as-stop").value);
			if (!goal) { showError("请填写工作目标"); return; }
			if (!start || !stop) { showError("请填写开始与停止时间"); return; }
			if (stop <= start) { showError("停止时间必须晚于开始时间"); return; }
			var body = {
				goal: goal,
				mode: document.getElementById("as-mode").value,
				startAtUtc: start,
				stopAtUtc: stop,
				repeat: document.getElementById("as-repeat").value,
				enabled: true,
				clientTimeZone: systemTz()
			};
			if (window.__asEditId) body.id = window.__asEditId;
			try {
				await api("POST", "/schedules", body);
				clearForm();
				await loadSchedules();
			} catch (e) {
				showError("保存失败: " + (e && e.message ? e.message : String(e)));
			}
		}

		async function deleteSchedule(id) {
			try {
				await api("POST", "/delete", { id: id });
				if (window.__asEditId === id) clearForm();
				await loadSchedules();
			} catch (e) {
				showError("删除失败: " + (e && e.message ? e.message : String(e)));
			}
		}

		async function toggleSchedule(id, enabled) {
			try {
				await api("POST", "/toggle", { id: id, enabled: enabled });
				await loadSchedules();
			} catch (e) {
				showError("切换失败: " + (e && e.message ? e.message : String(e)));
			}
		}

		async function runNow(id) {
			try {
				await api("POST", "/run-now", { id: id });
				await loadSchedules();
			} catch (e) {
				showError("执行失败: " + (e && e.message ? e.message : String(e)));
			}
		}

		function editSchedule(id) {
			var s = null;
			for (var i = 0; i < schedules.length; i++) if (schedules[i].id === id) { s = schedules[i]; break; }
			if (!s) return;
			window.__asEditId = id;
			document.getElementById("as-goal").value = s.goal || "";
			document.getElementById("as-mode").value = s.mode || "default";
			document.getElementById("as-repeat").value = s.repeat || "once";
			document.getElementById("as-start").value = toLocalInput(s.startAtUtc);
			document.getElementById("as-stop").value = toLocalInput(s.stopAtUtc);
			clearError();
		}

		function renderList() {
			var list = document.getElementById("as-list");
			if (!list) return;
			if (schedules.length === 0) {
				list.innerHTML = "<div class=\"as-empty\">暂无定时任务。填写上方表单并保存，到点后 dsh 会自动开始工作。</div>";
				return;
			}
			var html = "";
			for (var i = 0; i < schedules.length; i++) {
				var s = schedules[i];
				var modeCls = s.mode === "silent" ? "as-badge-silent" : "as-badge-default";
				var next = s.status === "running" ? "" : (s.nextRunAtUtc ? ("下次执行: " + countdown(s.nextRunAtUtc)) : "无待执行的窗口");
				var sess = s.sessionId ? (" 会话: " + s.sessionId) : "";
				html += "<div class=\"as-item\" data-id=\"" + escapeHtml(s.id) + "\">" +
					"<div class=\"as-item-head\"><span class=\"as-goal\">" + escapeHtml(s.goal) + "</span>" +
					"<span class=\"as-badge " + modeCls + "\">" + modeText(s) + "</span>" +
					"<span class=\"as-badge " + statusClass(s) + "\">" + statusText(s) + "</span></div>" +
					"<div class=\"as-item-times\">" + fmtLocal(s.startAtUtc) + " → " + fmtLocal(s.stopAtUtc) + " · " + (s.repeat === "daily" ? "每天" : "仅一次") + "</div>" +
					"<div class=\"as-item-times\">" + next + sess + (s.lastError ? (" · " + escapeHtml(s.lastError)) : "") + "</div>" +
					"<div class=\"as-item-actions\">" +
					"<label class=\"as-toggle-label\"><input type=\"checkbox\" data-act=\"toggle\" data-id=\"" + escapeHtml(s.id) + "\"" + (s.enabled ? " checked" : "") + "> 启用</label>" +
					"<button class=\"as-btn as-btn-mini\" data-act=\"run\" data-id=\"" + escapeHtml(s.id) + "\" type=\"button\">立即执行</button>" +
					"<button class=\"as-btn as-btn-mini\" data-act=\"edit\" data-id=\"" + escapeHtml(s.id) + "\" type=\"button\">编辑</button>" +
					"<button class=\"as-btn as-btn-mini as-btn-danger\" data-act=\"del\" data-id=\"" + escapeHtml(s.id) + "\" type=\"button\">删除</button>" +
					"</div></div>";
			}
			list.innerHTML = html;
		}

		// ---------- sidebar entry (DOM injection + self-healing) ----------
		function sidebarRoot() {
			var column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]");
			if (column === null) return undefined;
			var logoRow = column.querySelector("[class*=\"logoRow\"]");
			return logoRow !== null ? logoRow.parentElement : column.firstElementChild;
		}

		function newSessionButton(root) {
			var nested = root.querySelector("button[class*=\"newSession\"]");
			if (nested !== null) return nested;
			for (var i = 0; i < root.children.length; i++) {
				if (root.children[i].tagName === "BUTTON") return root.children[i];
			}
			return undefined;
		}

		function createEntry() {
			var entry = document.createElement("button");
			entry.type = "button";
			entry.setAttribute("data-dsh-autosched-entry", "");
			entry.className = "as-entry";
			entry.setAttribute("aria-label", "自动工作");
			entry.innerHTML = "<span class=\"as-entry-icon\">⏱</span><span class=\"as-entry-label\">自动工作</span>";
			entry.addEventListener("click", function () {
				buildPanel();
				setOpen(!panelOpen);
				loadSchedules();
			});
			return entry;
		}

		function placeEntry(root, entry) {
			var button = newSessionButton(root);
			if (button === undefined) return false;
			if (entry.parentElement !== root) {
				var row = button.closest("[class*=\"logoRow\"]");
				var base = row !== null && row.parentElement === root ? row : button;
				var family = Array.prototype.filter.call(root.children, function (el) {
					return el instanceof HTMLElement && el.matches("[data-dsh-autosched-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]");
				});
				var anchor = family.length > 0 ? family[0] : base.nextElementSibling;
				root.insertBefore(entry, anchor);
			}
			return true;
		}

		function mountSidebarEntry() {
			if (document.querySelector("[data-dsh-autosched-entry]") !== null) return;
			entryEl = createEntry();
			var root = null;
			var placed = false;
			var rootObserver = null;
			var tryPlace = function () {
				if (root !== null && !root.isConnected) {
					if (rootObserver) rootObserver.disconnect();
					root = null;
					placed = false;
				}
				if (placed) {
					if (document.body.contains(entryEl)) return;
					if (rootObserver) rootObserver.disconnect();
					root = null;
					placed = false;
				}
				if (root === null) root = sidebarRoot();
				if (root === undefined || root === null) return;
				placed = placeEntry(root, entryEl);
				if (placed) {
					rootObserver = new MutationObserver(function () {
						if (root === null || !root.isConnected) {
							placed = false;
							tryPlace();
							return;
						}
						if (!root.contains(entryEl)) placed = placeEntry(root, entryEl);
					});
					rootObserver.observe(root, { childList: true, subtree: true });
					observers.push(rootObserver);
				}
			};
			var waitObserver = new MutationObserver(function () { tryPlace(); });
			waitObserver.observe(document.body, { childList: true, subtree: true });
			observers.push(waitObserver);
			tryPlace();
		}

		// ---------- css ----------
		function injectCss() {
			if (document.getElementById("as-style")) return;
			var style = document.createElement("style");
			style.id = "as-style";
			style.textContent = "" +
				".as-entry{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9aa3b2);font-size:13px;cursor:pointer;border-radius:8px;text-align:left;}" +
				".as-entry:hover{background:var(--dsw-alias-bg-module-platform,#23252c);color:var(--dsw-alias-label-primary,#e6e8ee);}" +
				".as-entry[data-active]{background:var(--dsw-alias-bg-module-platform,#23252c);color:var(--dsw-alias-label-primary,#e6e8ee);}" +
				".as-entry-icon{font-size:14px;}" +
				"#dsh-autosched-panel{position:fixed;top:0;right:0;height:100vh;width:430px;max-width:94vw;z-index:1200;background:var(--dsw-alias-bg-layer-1,#181a20);border-left:1px solid var(--dsw-alias-border-l2,#2c2f38);box-shadow:-12px 0 32px rgba(0,0,0,.35);padding:16px;box-sizing:border-box;overflow-y:auto;display:none;color:var(--dsw-alias-label-primary,#e6e8ee);font-size:13px;}" +
				"#dsh-autosched-panel.as-open{display:block;}" +
				".as-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}" +
				".as-title{font-size:16px;font-weight:600;}" +
				".as-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#7c8494);font-weight:400;margin-left:6px;}" +
				".as-close{background:transparent;border:0;color:var(--dsw-alias-label-tertiary,#7c8494);font-size:18px;cursor:pointer;line-height:1;}" +
				".as-note{background:var(--dsw-alias-bg-module-platform,#23252c);border-radius:8px;padding:8px 10px;margin-bottom:12px;color:var(--dsw-alias-label-secondary,#9aa3b2);font-size:12px;line-height:1.5;}" +
				".as-form{display:flex;flex-direction:column;gap:8px;margin-bottom:14px;}" +
				".as-label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa3b2);margin-bottom:4px;}" +
				".as-form textarea,.as-form input,.as-form select{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,#1f222a);border:1px solid var(--dsw-alias-border-l2,#2c2f38);border-radius:8px;color:inherit;padding:8px 10px;font-size:13px;font-family:inherit;}" +
				".as-form textarea{resize:vertical;}" +
				".as-row2{display:flex;gap:10px;}" +
				".as-row2>div{flex:1;min-width:0;}" +
				".as-presets{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}" +
				".as-preset-label{color:var(--dsw-alias-label-tertiary,#7c8494);font-size:12px;}" +
				".as-warn{color:var(--dsw-alias-state-warn-primary,#d8a03a);font-size:12px;line-height:1.5;}" +
				".as-actions{display:flex;gap:8px;}" +
				".as-error{display:none;color:var(--dsw-alias-state-error-primary,#e5534b);font-size:12px;margin-top:4px;}" +
				".as-btn{background:var(--dsw-alias-bg-module-platform,#23252c);border:1px solid var(--dsw-alias-border-l2,#2c2f38);color:var(--dsw-alias-label-primary,#e6e8ee);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;}" +
				".as-btn:hover{border-color:var(--dsw-alias-brand-primary,#5b7cfa);}" +
				".as-btn-primary{background:var(--dsw-alias-brand-primary,#5b7cfa);border-color:transparent;color:#fff;}" +
				".as-btn-mini{padding:4px 10px;font-size:12px;}" +
				".as-btn-danger{color:var(--dsw-alias-state-error-primary,#e5534b);}" +
				".as-list{display:flex;flex-direction:column;gap:10px;}" +
				".as-empty{color:var(--dsw-alias-label-tertiary,#7c8494);font-size:12px;line-height:1.6;padding:8px 0;}" +
				".as-item{border:1px solid var(--dsw-alias-border-l2,#2c2f38);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2,#1f222a);}" +
				".as-item-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}" +
				".as-goal{flex:1;min-width:0;font-weight:600;overflow-wrap:anywhere;}" +
				".as-badge{font-size:11px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform,#23252c);color:var(--dsw-alias-label-secondary,#9aa3b2);white-space:nowrap;}" +
				".as-badge-silent{background:rgba(91,124,250,.16);color:#9db3ff;}" +
				".as-badge-default{background:rgba(216,160,58,.16);color:#e7c076;}" +
				".as-running{background:rgba(63,185,80,.16);color:#7ee2a8;}" +
				".as-error{background:rgba(229,83,75,.16);color:#f2a09c;}" +
				".as-idle{background:var(--dsw-alias-bg-module-platform,#23252c);color:var(--dsw-alias-label-secondary,#9aa3b2);}" +
				".as-item-times{color:var(--dsw-alias-label-tertiary,#7c8494);font-size:12px;margin-top:4px;overflow-wrap:anywhere;}" +
				".as-item-actions{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;}" +
				".as-toggle-label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa3b2);}";
				".as-float{position:fixed;right:16px;bottom:16px;z-index:1199;width:44px;height:44px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,#2c2f38);background:var(--dsw-alias-bg-layer-2,#1f222a);color:var(--dsw-alias-label-primary,#e6e8ee);font-size:18px;line-height:1;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.4);}" +
			document.head.appendChild(style);
		}

		// ---------- lifecycle ----------
		function dispose() {
			disposed = true;
			for (var i = 0; i < timers.length; i++) clearInterval(timers[i]);
			timers = [];
			for (var j = 0; j < observers.length; j++) observers[j].disconnect();
			observers = [];
			if (entryEl && entryEl.parentElement) entryEl.parentElement.removeChild(entryEl);
			entryEl = null;
			if (panelEl && panelEl.parentElement) panelEl.parentElement.removeChild(panelEl);
			panelEl = null;
			var floatEl = document.querySelector("[data-dsh-autosched-float]");
			if (floatEl && floatEl.parentElement) floatEl.parentElement.removeChild(floatEl);
			var style = document.getElementById("as-style");
			if (style && style.parentElement) style.parentElement.removeChild(style);
		}

		function mountFloatingButton() {
			if (!document.body) return;
			if (document.querySelector("[data-dsh-autosched-float]") !== null) return;
			var btn = document.createElement("button");
			btn.type = "button";
			btn.setAttribute("data-dsh-autosched-float", "");
			btn.className = "as-float";
			btn.innerHTML = "⏱";
			btn.title = "自动工作";
			btn.addEventListener("click", function () {
				buildPanel();
				setOpen(!panelOpen);
				loadSchedules();
			});
			document.body.appendChild(btn);
		}

		function mountWhenReady() {
			var mounted = false;
			var doMount = function () {
				if (mounted || disposed) return;
				if (!document.body) return;
				mounted = true;
				mountSidebarEntry();
				if (window.innerWidth < 900) mountFloatingButton();
				setTimeout(function () {
					if (disposed) return;
					if (document.querySelector("[data-dsh-autosched-entry]") === null) mountFloatingButton();
				}, 6000);
			};
			if (document.body) { doMount(); return; }
			document.addEventListener("DOMContentLoaded", doMount);
			setTimeout(doMount, 0);
		}

		function apply(ctx) {
			if (window.__dshAutoSchedulerMounted) return;
			window.__dshAutoSchedulerMounted = true;
			try {
				injectCss();
				mountWhenReady();
				timers.push(setInterval(loadSchedules, POLL_MS));
				timers.push(setInterval(renderList, 1000));
				loadSchedules();
				ctx.effect(function () {
					return function () {
						window.__dshAutoSchedulerMounted = false;
						dispose();
					};
				}, "dsh-auto-scheduler: ui");
			} catch (e) {
				try { console.error("[dsh-auto-scheduler] apply failed:", e); } catch (e2) {}
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
