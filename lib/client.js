window.__ModuleLoader__.load({
	id: "dsh-auto-scheduler",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var inject = [];
		var API_BASE = "/api/dsh-auto-scheduler";
		var POLL_MS = 10000;
		var TICK_MS = 1000;
		var POS_KEY = "dsh-autosched-widget-pos";

		var schedules = [];
		var listSignature = "";
		var listRefs = {};
		var popOpen = false;
		var disposed = false;
		var loading = false;
		var saving = false;
		var editId = null;
		var dragState = null;
		var suppressClick = false;
		var timers = [];
		var observers = [];
		var healObserver = null;
		var widgetEl = null;
		var popoverEl = null;

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

		function errMsg(e) { return e && e.message ? e.message : String(e); }

		function clampNumber(v, min, max) { return Math.min(Math.max(min, v), max); }

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

		function findSchedule(id) {
			for (var i = 0; i < schedules.length; i++) if (schedules[i].id === id) return schedules[i];
			return null;
		}

		function scheduleSignature(list) {
			var out = [];
			for (var i = 0; i < list.length; i++) {
				var s = list[i];
				out.push([s.id, s.goal, s.mode, s.repeat, s.enabled ? 1 : 0, s.status, s.startAtUtc, s.stopAtUtc, s.nextRunAtUtc || "", s.sessionId || "", s.lastError || ""].join("|"));
			}
			return out.join("\n");
		}

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
			if (loading || disposed) return;
			loading = true;
			try {
				var data = await api("GET", "/schedules");
				if (disposed) return;
				schedules = data.schedules || [];
				var sig = scheduleSignature(schedules);
				if (sig !== listSignature) {
					listSignature = sig;
					renderList();
				}
				updateWidgetState();
				clearError();
			} catch (e) {
				showError("加载失败: " + errMsg(e));
			} finally {
				loading = false;
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

		// ---------- hourglass widget ----------
		var WIDGET_SVG = "" +
			"<svg class=\"as-svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\">" +
			"<rect class=\"as-bar\" x=\"5\" y=\"1.8\" width=\"14\" height=\"1.7\" rx=\"0.85\"></rect>" +
			"<rect class=\"as-bar\" x=\"5\" y=\"20.5\" width=\"14\" height=\"1.7\" rx=\"0.85\"></rect>" +
			"<path class=\"as-glass\" d=\"M7 3.5h10v3.1L12.8 12 17 17.4v3.1H7v-3.1L11.2 12 7 6.6z\"></path>" +
			"<path class=\"as-sand as-sand-top\" d=\"M8.4 6.5h7.2L12 11z\"></path>" +
			"<line class=\"as-stream\" x1=\"12\" y1=\"12.3\" x2=\"12\" y2=\"17.2\"></line>" +
			"<path class=\"as-sand as-sand-bottom\" d=\"M8.3 20.3h7.4l-2.5-2.9a1.7 1.7 0 0 0-2.4 0z\"></path>" +
			"</svg>";

		function clampPos(x, y) {
			var size = (widgetEl && widgetEl.offsetWidth) || 48;
			var maxX = Math.max(4, window.innerWidth - size - 4);
			var maxY = Math.max(4, window.innerHeight - size - 4);
			return { x: clampNumber(x, 4, maxX), y: clampNumber(y, 4, maxY) };
		}

		function applyStoredPos() {
			if (!widgetEl) return;
			var pos = null;
			try {
				var raw = window.localStorage.getItem(POS_KEY);
				if (raw) pos = JSON.parse(raw);
			} catch (e) { pos = null; }
			var p;
			if (pos && typeof pos.x === "number" && typeof pos.y === "number" && isFinite(pos.x) && isFinite(pos.y)) {
				p = clampPos(pos.x, pos.y);
			} else {
				p = clampPos(window.innerWidth - 68, window.innerHeight - 116);
			}
			widgetEl.style.left = p.x + "px";
			widgetEl.style.top = p.y + "px";
		}

		function savePos() {
			if (!widgetEl) return;
			var r = widgetEl.getBoundingClientRect();
			try { window.localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })); } catch (e) {}
		}

		function onWidgetPointerDown(event) {
			if (event.button !== undefined && event.button !== 0) return;
			var rect = widgetEl.getBoundingClientRect();
			dragState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origX: rect.left, origY: rect.top, moved: false };
			try { widgetEl.setPointerCapture(event.pointerId); } catch (e) {}
		}

		function onWidgetPointerMove(event) {
			if (!dragState || event.pointerId !== dragState.pointerId) return;
			var dx = event.clientX - dragState.startX;
			var dy = event.clientY - dragState.startY;
			if (!dragState.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
			dragState.moved = true;
			widgetEl.classList.add("as-dragging");
			var p = clampPos(dragState.origX + dx, dragState.origY + dy);
			widgetEl.style.left = p.x + "px";
			widgetEl.style.top = p.y + "px";
			if (popOpen) positionPopover();
		}

		function onWidgetPointerUp(event) {
			if (!dragState || event.pointerId !== dragState.pointerId) return;
			var moved = dragState.moved;
			dragState = null;
			widgetEl.classList.remove("as-dragging");
			try { widgetEl.releasePointerCapture(event.pointerId); } catch (e) {}
			if (moved) { suppressClick = true; savePos(); }
		}

		function onWidgetPointerCancel(event) {
			if (!dragState || event.pointerId !== dragState.pointerId) return;
			dragState = null;
			widgetEl.classList.remove("as-dragging");
		}

		function onWidgetClick(event) {
			if (suppressClick) { suppressClick = false; event.preventDefault(); return; }
			togglePopover();
		}

		function mountWidget() {
			if (!document.body) return;
			if (widgetEl && widgetEl.isConnected) return;
			var stale = document.querySelector("[data-dsh-autosched-widget]");
			if (stale && stale.parentElement) stale.parentElement.removeChild(stale);
			var el = document.createElement("button");
			el.type = "button";
			el.setAttribute("data-dsh-autosched-widget", "");
			el.className = "as-widget";
			el.title = "自动工作（点击打开，可拖动）";
			el.setAttribute("aria-label", "自动工作");
			el.setAttribute("aria-expanded", "false");
			el.innerHTML = WIDGET_SVG;
			el.addEventListener("pointerdown", onWidgetPointerDown);
			el.addEventListener("pointermove", onWidgetPointerMove);
			el.addEventListener("pointerup", onWidgetPointerUp);
			el.addEventListener("pointercancel", onWidgetPointerCancel);
			el.addEventListener("click", onWidgetClick);
			el.style.left = "-100px";
			el.style.top = "-100px";
			document.body.appendChild(el);
			widgetEl = el;
			applyStoredPos();
			updateWidgetState();
		}

		function updateWidgetState() {
			if (!widgetEl) return;
			var live = false;
			for (var i = 0; i < schedules.length; i++) {
				if (schedules[i].status === "running") { live = true; break; }
			}
			widgetEl.classList.toggle("as-live", live);
		}

		// ---------- popover ----------
		var POP_HTML = "" +
			"<div class=\"as-head\"><div class=\"as-title\">自动工作 <span class=\"as-sub\">定时开始 / 停止</span></div>" +
			"<button class=\"as-close\" id=\"as-close\" type=\"button\" aria-label=\"关闭\">&times;</button></div>" +
			"<div class=\"as-note\">时间按本机时区显示（<span id=\"as-tz\"></span>），保存后内部转为 UTC；ds 谷峰时段为北京时间（UTC+8），已按本机时区换算填充。每段时间会保存为一条独立的定时记录。</div>" +
			"<div class=\"as-form\">" +
			"<label class=\"as-label\">工作目标</label>" +
			"<textarea id=\"as-goal\" rows=\"3\" placeholder=\"例如：修复 xxx 项目的构建错误并提交 PR\"></textarea>" +
			"<div class=\"as-row2\">" +
			"<div><label class=\"as-label\">模式</label><select id=\"as-mode\"><option value=\"default\">默认模式（可提问）</option><option value=\"silent\">静默模式（不提问，完成前不停）</option></select></div>" +
			"<div><label class=\"as-label\">重复</label><select id=\"as-repeat\"><option value=\"once\">仅一次</option><option value=\"daily\">每天</option></select></div>" +
			"</div>" +
			"<label class=\"as-label\">时间段（可添加多个）</label>" +
			"<div class=\"as-seg-list\" id=\"as-segments\"></div>" +
			"<div><button class=\"as-btn as-btn-mini\" id=\"as-add-seg\" type=\"button\">＋ 添加时间段</button></div>" +
			"<div id=\"as-edit-hint\" class=\"as-edit-hint\"></div>" +
			"<div class=\"as-warn\">静默模式 = danger-full-access 全权限无人值守执行，请只在信任的任务上使用。</div>" +
			"<div class=\"as-actions\">" +
			"<button class=\"as-btn as-btn-primary\" id=\"as-save\" type=\"button\">保存任务</button>" +
			"<button class=\"as-btn\" id=\"as-clear\" type=\"button\">清空表单</button>" +
			"</div>" +
			"<div id=\"as-error\" class=\"as-msg\"></div>" +
			"</div>" +
			"<div class=\"as-list\" id=\"as-list\"></div>";

		function buildPopover() {
			if (popoverEl) return;
			var el = document.createElement("div");
			el.id = "dsh-autosched-pop";
			el.className = "as-pop";
			el.setAttribute("data-dsh-autosched-pop", "");
			el.innerHTML = POP_HTML;
			document.body.appendChild(el);
			popoverEl = el;
			var tzEl = document.getElementById("as-tz");
			if (tzEl) tzEl.textContent = systemTz();
			document.getElementById("as-close").addEventListener("click", function () { setOpen(false); });
			document.getElementById("as-save").addEventListener("click", saveForm);
			document.getElementById("as-clear").addEventListener("click", clearForm);
			document.getElementById("as-add-seg").addEventListener("click", function () { addSegmentRow("", ""); });
			var list = document.getElementById("as-list");
			list.addEventListener("click", onListClick);
			list.addEventListener("change", onListChange);
			addSegmentRow("", "");
			renderList();
		}

		function setOpen(next) {
			popOpen = next;
			if (popoverEl) popoverEl.classList.toggle("as-open", next);
			if (widgetEl) {
				widgetEl.setAttribute("aria-expanded", next ? "true" : "false");
				widgetEl.classList.toggle("as-open-state", next);
			}
		}

		function togglePopover() {
			if (!popoverEl) buildPopover();
			if (popOpen) {
				setOpen(false);
			} else {
				setOpen(true);
				positionPopover();
				loadSchedules();
			}
		}

		function positionPopover() {
			if (!popoverEl || !widgetEl) return;
			var wr = widgetEl.getBoundingClientRect();
			var pr = popoverEl.getBoundingClientRect();
			var gap = 10;
			var top;
			if (wr.top - pr.height - gap >= 8) {
				top = wr.top - pr.height - gap;
			} else {
				top = Math.min(wr.bottom + gap, Math.max(8, window.innerHeight - pr.height - 8));
			}
			top = Math.max(8, top);
			var left = wr.left + wr.width / 2 - pr.width / 2;
			left = clampNumber(left, 8, Math.max(8, window.innerWidth - pr.width - 8));
			popoverEl.style.left = Math.round(left) + "px";
			popoverEl.style.top = Math.round(top) + "px";
		}

		// ---------- segments ----------
		function addSegmentRow(startValue, stopValue) {
			var wrap = document.getElementById("as-segments");
			if (!wrap) return null;
			var row = document.createElement("div");
			row.className = "as-seg";
			row.innerHTML = "" +
				"<div class=\"as-seg-row\">" +
				"<input type=\"datetime-local\" class=\"as-seg-start\" title=\"开始时间（本机）\"" + (startValue ? " value=\"" + startValue + "\"" : "") + ">" +
				"<span class=\"as-seg-arrow\">→</span>" +
				"<input type=\"datetime-local\" class=\"as-seg-stop\" title=\"停止时间（本机）\"" + (stopValue ? " value=\"" + stopValue + "\"" : "") + ">" +
				"<button class=\"as-seg-del\" type=\"button\" title=\"删除该时间段\" aria-label=\"删除该时间段\">&times;</button>" +
				"</div>" +
				"<div class=\"as-seg-presets\"><span class=\"as-preset-label\">ds 谷峰：</span>" +
				"<button class=\"as-btn as-btn-mini as-valley\" type=\"button\" data-utc-hour=\"4\" data-dur=\"7200000\">谷 12:00–14:00</button>" +
				"<button class=\"as-btn as-btn-mini as-valley\" type=\"button\" data-utc-hour=\"10\" data-dur=\"54000000\">谷 18:00–次日 9:00</button>" +
				"</div>";
			row.querySelector(".as-seg-del").addEventListener("click", function () {
				if (row.parentElement) row.parentElement.removeChild(row);
				var w = document.getElementById("as-segments");
				if (w && w.children.length === 0) addSegmentRow("", "");
			});
			var valleyButtons = row.querySelectorAll(".as-valley");
			for (var i = 0; i < valleyButtons.length; i++) {
				valleyButtons[i].addEventListener("click", function () {
					fillValleyInto(row, Number(this.getAttribute("data-utc-hour")), Number(this.getAttribute("data-dur")));
				});
			}
			wrap.appendChild(row);
			return row;
		}

		function fillValleyInto(row, startUtcHour, durationMs) {
			var w = valleyWindow(startUtcHour, durationMs);
			if (!w) { showError("无法计算谷峰时段"); return; }
			var startInput = row.querySelector(".as-seg-start");
			var stopInput = row.querySelector(".as-seg-stop");
			if (startInput) startInput.value = toLocalInput(new Date(w.startAt).toISOString());
			if (stopInput) stopInput.value = toLocalInput(new Date(w.stopAt).toISOString());
			clearError();
		}

		function updateEditHint() {
			var el = document.getElementById("as-edit-hint");
			if (!el) return;
			if (editId) {
				el.textContent = "正在编辑一条已有记录：保存将更新该记录；新增的时间段会另存为新的记录。";
				el.style.display = "block";
			} else {
				el.textContent = "";
				el.style.display = "none";
			}
		}

		function clearForm() {
			var goal = document.getElementById("as-goal");
			if (goal) goal.value = "";
			var mode = document.getElementById("as-mode");
			if (mode) mode.value = "default";
			var repeat = document.getElementById("as-repeat");
			if (repeat) repeat.value = "once";
			var wrap = document.getElementById("as-segments");
			if (wrap) wrap.textContent = "";
			addSegmentRow("", "");
			editId = null;
			updateEditHint();
			clearError();
		}

		async function saveForm() {
			if (saving) return;
			var goal = document.getElementById("as-goal").value.trim();
			var mode = document.getElementById("as-mode").value;
			var repeat = document.getElementById("as-repeat").value;
			if (!goal) { showError("请填写工作目标"); return; }
			var rows = document.querySelectorAll("#as-segments .as-seg");
			var segs = [];
			for (var i = 0; i < rows.length; i++) {
				var startIso = fromLocalInput(rows[i].querySelector(".as-seg-start").value);
				var stopIso = fromLocalInput(rows[i].querySelector(".as-seg-stop").value);
				if (!startIso || !stopIso) { showError("请填写时间段 " + (i + 1) + " 的开始与停止时间"); return; }
				if (stopIso <= startIso) { showError("时间段 " + (i + 1) + "：停止时间必须晚于开始时间"); return; }
				segs.push({ startAtUtc: startIso, stopAtUtc: stopIso });
			}
			if (segs.length === 0) { showError("请至少添加一个时间段"); return; }
			saving = true;
			var saveBtn = document.getElementById("as-save");
			if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "保存中…"; }
			try {
				var failed = 0;
				for (var j = 0; j < segs.length; j++) {
					var body = {
						goal: goal,
						mode: mode,
						startAtUtc: segs[j].startAtUtc,
						stopAtUtc: segs[j].stopAtUtc,
						repeat: repeat,
						enabled: true,
						clientTimeZone: systemTz()
					};
					if (j === 0 && editId) body.id = editId;
					try {
						await api("POST", "/schedules", body);
					} catch (err) {
						failed++;
						if (segs.length === 1) throw err;
					}
				}
				if (failed > 0) {
					showError("部分保存失败：" + (segs.length - failed) + "/" + segs.length + " 个时间段已保存，请重试失败的部分");
				} else {
					clearForm();
				}
				await loadSchedules();
			} catch (e) {
				showError("保存失败: " + errMsg(e));
			} finally {
				saving = false;
				if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "保存任务"; }
			}
		}

		// ---------- schedule actions ----------
		async function deleteSchedule(id) {
			try {
				await api("POST", "/delete", { id: id });
				if (editId === id) clearForm();
				await loadSchedules();
			} catch (e) {
				showError("删除失败: " + errMsg(e));
			}
		}

		async function toggleSchedule(id, enabled) {
			try {
				await api("POST", "/toggle", { id: id, enabled: enabled });
				await loadSchedules();
			} catch (e) {
				showError("切换失败: " + errMsg(e));
			}
		}

		async function runNow(id) {
			try {
				await api("POST", "/run-now", { id: id });
				await loadSchedules();
			} catch (e) {
				showError("执行失败: " + errMsg(e));
			}
		}

		function editSchedule(id) {
			var s = findSchedule(id);
			if (!s) return;
			editId = id;
			var goal = document.getElementById("as-goal");
			if (goal) goal.value = s.goal || "";
			var mode = document.getElementById("as-mode");
			if (mode) mode.value = s.mode || "default";
			var repeat = document.getElementById("as-repeat");
			if (repeat) repeat.value = s.repeat || "once";
			var wrap = document.getElementById("as-segments");
			if (wrap) wrap.textContent = "";
			addSegmentRow(toLocalInput(s.startAtUtc), toLocalInput(s.stopAtUtc));
			updateEditHint();
			clearError();
		}

		// ---------- list rendering (targeted updates) ----------
		function buildItem(s) {
			var item = document.createElement("div");
			item.className = "as-item";
			item.setAttribute("data-id", s.id);
			var nextHtml;
			if (s.status === "running") {
				nextHtml = "进行中";
			} else if (s.nextRunAtUtc) {
				nextHtml = "下次执行: <span class=\"as-countdown\">" + escapeHtml(countdown(s.nextRunAtUtc)) + "</span>";
			} else {
				nextHtml = "无待执行的窗口";
			}
			var sess = s.sessionId ? (" 会话: " + escapeHtml(s.sessionId)) : "";
			var err = s.lastError ? (" · " + escapeHtml(s.lastError)) : "";
			var modeCls = s.mode === "silent" ? "as-badge-silent" : "as-badge-default";
			item.innerHTML = "" +
				"<div class=\"as-item-head\"><span class=\"as-goal\">" + escapeHtml(s.goal) + "</span>" +
				"<span class=\"as-badge " + modeCls + "\">" + modeText(s) + "</span>" +
				"<span class=\"as-badge " + statusClass(s) + "\">" + statusText(s) + "</span></div>" +
				"<div class=\"as-item-times\">" + fmtLocal(s.startAtUtc) + " → " + fmtLocal(s.stopAtUtc) + " · " + (s.repeat === "daily" ? "每天" : "仅一次") + "</div>" +
				"<div class=\"as-item-times\">" + nextHtml + sess + err + "</div>" +
				"<div class=\"as-item-actions\">" +
				"<label class=\"as-toggle-label\"><input type=\"checkbox\" data-act=\"toggle\" data-id=\"" + escapeHtml(s.id) + "\"" + (s.enabled ? " checked" : "") + "> 启用</label>" +
				"<button class=\"as-btn as-btn-mini\" data-act=\"run\" data-id=\"" + escapeHtml(s.id) + "\" type=\"button\">立即执行</button>" +
				"<button class=\"as-btn as-btn-mini\" data-act=\"edit\" data-id=\"" + escapeHtml(s.id) + "\" type=\"button\">编辑</button>" +
				"<button class=\"as-btn as-btn-mini as-btn-danger\" data-act=\"del\" data-id=\"" + escapeHtml(s.id) + "\" type=\"button\">删除</button>" +
				"</div>";
			var cd = item.querySelector(".as-countdown");
			listRefs[s.id] = { countdown: cd || null };
			return item;
		}

		function renderList() {
			var list = document.getElementById("as-list");
			if (!list) return;
			listRefs = {};
			if (schedules.length === 0) {
				list.innerHTML = "<div class=\"as-empty\">暂无定时任务。填写上方表单并保存，到点后 dsh 会自动开始工作。</div>";
				return;
			}
			list.textContent = "";
			for (var i = 0; i < schedules.length; i++) list.appendChild(buildItem(schedules[i]));
		}

		function onListClick(event) {
			var list = event.currentTarget;
			var target = event.target;
			while (target && target !== list && !(target.getAttribute && target.getAttribute("data-act"))) target = target.parentElement;
			if (!target || target === list) return;
			var act = target.getAttribute("data-act");
			var id = target.getAttribute("data-id");
			if (act === "del") deleteSchedule(id);
			else if (act === "run") runNow(id);
			else if (act === "edit") editSchedule(id);
		}

		function onListChange(event) {
			var target = event.target;
			if (target && target.getAttribute && target.getAttribute("data-act") === "toggle") {
				toggleSchedule(target.getAttribute("data-id"), target.checked);
			}
		}

		// 1s tick: only touch countdown text nodes (no DOM rebuild).
		function tick() {
			for (var i = 0; i < schedules.length; i++) {
				var s = schedules[i];
				var ref = listRefs[s.id];
				if (ref && ref.countdown) ref.countdown.textContent = countdown(s.nextRunAtUtc);
			}
			updateWidgetState();
		}

		// ---------- css ----------
		var CSS_TEXT = "" +
			".as-widget{position:fixed;left:0;top:0;z-index:1201;width:48px;height:48px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,#2c2f38);background:radial-gradient(circle at 35% 30%,#262a33,#181a20);cursor:grab;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.4);padding:0;touch-action:none;-webkit-user-select:none;user-select:none;}" +
			".as-widget:hover{border-color:var(--dsw-alias-brand-primary,#5b7cfa);}" +
			".as-widget.as-open-state{border-color:var(--dsw-alias-brand-primary,#5b7cfa);}" +
			".as-widget.as-dragging{cursor:grabbing;}" +
			".as-widget::after{content:\"\";position:absolute;left:-4px;top:-4px;right:-4px;bottom:-4px;border-radius:50%;box-shadow:0 0 14px 2px rgba(231,192,118,.25);opacity:.5;animation:as-glow 4.5s ease-in-out infinite;pointer-events:none;}" +
			".as-svg{width:26px;height:26px;display:block;overflow:visible;}" +
			".as-glass{fill:none;stroke:#a7b0bf;stroke-width:1.1;opacity:.9;}" +
			".as-bar{fill:#a7b0bf;}" +
			".as-sand{fill:#e7c076;opacity:.95;}" +
			".as-stream{stroke:#e7c076;stroke-width:1.1;stroke-linecap:round;stroke-dasharray:1.4 2.2;opacity:.9;animation:as-stream 1.15s linear infinite;}" +
			".as-sand-top{transform-box:fill-box;transform-origin:50% 100%;animation:as-top 7s ease-in-out infinite alternate;}" +
			".as-sand-bottom{transform-box:fill-box;transform-origin:50% 100%;animation:as-bottom 7s ease-in-out infinite alternate;}" +
			".as-widget.as-live{border-color:rgba(126,226,168,.55);animation:as-pulse 2.6s ease-in-out infinite;}" +
			".as-widget.as-live::after{box-shadow:0 0 16px 3px rgba(126,226,168,.35);animation-duration:2.2s;}" +
			".as-widget.as-live .as-sand{fill:#7ee2a8;}" +
			".as-widget.as-live .as-stream{stroke:#7ee2a8;}" +
			".as-widget.as-live .as-glass{stroke:#8fd8ae;}" +
			".as-widget.as-live .as-bar{fill:#8fd8ae;}" +
			"@keyframes as-stream{to{stroke-dashoffset:-14.4;}}" +
			"@keyframes as-top{from{transform:scaleY(1);}to{transform:scaleY(.5);}}" +
			"@keyframes as-bottom{from{transform:scaleY(.55);}to{transform:scaleY(1);}}" +
			"@keyframes as-glow{0%,100%{opacity:.3;}50%{opacity:.75;}}" +
			"@keyframes as-pulse{0%,100%{transform:scale(1);}50%{transform:scale(1.045);}}" +
			".as-pop{position:fixed;z-index:1200;width:400px;max-width:calc(100vw - 20px);max-height:calc(100vh - 20px);overflow-y:auto;background:var(--dsw-alias-bg-layer-1,#181a20);border:1px solid var(--dsw-alias-border-l2,#2c2f38);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.5);padding:14px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#e6e8ee);font-size:13px;display:none;}" +
			".as-pop.as-open{display:block;}" +
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
			".as-seg-list{display:flex;flex-direction:column;gap:8px;}" +
			".as-seg{border:1px dashed var(--dsw-alias-border-l2,#2c2f38);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:6px;}" +
			".as-seg-row{display:flex;align-items:center;gap:6px;}" +
			".as-seg-row input{flex:1;min-width:0;}" +
			".as-seg-arrow{color:var(--dsw-alias-label-tertiary,#7c8494);}" +
			".as-seg-del{flex:0 0 auto;width:24px;height:24px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#2c2f38);background:transparent;color:var(--dsw-alias-label-tertiary,#7c8494);cursor:pointer;font-size:14px;line-height:1;padding:0;}" +
			".as-seg-del:hover{color:var(--dsw-alias-state-error-primary,#e5534b);border-color:var(--dsw-alias-state-error-primary,#e5534b);}" +
			".as-seg-presets{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}" +
			".as-preset-label{color:var(--dsw-alias-label-tertiary,#7c8494);font-size:12px;}" +
			".as-edit-hint{display:none;background:rgba(91,124,250,.12);color:#9db3ff;border-radius:8px;padding:6px 10px;font-size:12px;line-height:1.5;}" +
			".as-warn{color:var(--dsw-alias-state-warn-primary,#d8a03a);font-size:12px;line-height:1.5;}" +
			".as-actions{display:flex;gap:8px;}" +
			".as-msg{display:none;color:var(--dsw-alias-state-error-primary,#e5534b);font-size:12px;margin-top:4px;}" +
			".as-btn{background:var(--dsw-alias-bg-module-platform,#23252c);border:1px solid var(--dsw-alias-border-l2,#2c2f38);color:var(--dsw-alias-label-primary,#e6e8ee);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;}" +
			".as-btn:hover{border-color:var(--dsw-alias-brand-primary,#5b7cfa);}" +
			".as-btn[disabled]{opacity:.6;cursor:default;}" +
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
			".as-idle{background:var(--dsw-alias-bg-module-platform,#2c2f38);color:var(--dsw-alias-label-secondary,#9aa3b2);}" +
			".as-item-times{color:var(--dsw-alias-label-tertiary,#7c8494);font-size:12px;margin-top:4px;overflow-wrap:anywhere;}" +
			".as-countdown{color:var(--dsw-alias-label-secondary,#9aa3b2);font-variant-numeric:tabular-nums;}" +
			".as-item-actions{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;}" +
			".as-toggle-label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa3b2);}" +
			"@media (prefers-reduced-motion:reduce){.as-widget,.as-widget::after,.as-widget svg *{animation:none !important;}.as-pop,.as-pop *,.as-widget{transition:none !important;}}";

		function injectCss() {
			if (document.getElementById("as-style")) return;
			var style = document.createElement("style");
			style.id = "as-style";
			style.textContent = CSS_TEXT;
			document.head.appendChild(style);
		}

		// ---------- self-healing against host DOM changes ----------
		function startSelfHeal() {
			if (healObserver) return;
			var heal = function () {
				if (disposed) return;
				if (!document.getElementById("as-style")) injectCss();
				if (widgetEl && !widgetEl.isConnected && document.body) document.body.appendChild(widgetEl);
				if (popoverEl && popOpen && !popoverEl.isConnected && document.body) {
					document.body.appendChild(popoverEl);
					positionPopover();
				}
			};
			healObserver = new MutationObserver(function (mutations) {
				for (var i = 0; i < mutations.length; i++) {
					if (mutations[i].removedNodes.length) { heal(); return; }
				}
			});
			healObserver.observe(document.body, { childList: true, subtree: true });
			observers.push(healObserver);
		}

		function onResize() {
			if (disposed) return;
			if (widgetEl) {
				var r = widgetEl.getBoundingClientRect();
				var p = clampPos(r.left, r.top);
				widgetEl.style.left = p.x + "px";
				widgetEl.style.top = p.y + "px";
			}
			if (popOpen) positionPopover();
		}

		// ---------- lifecycle ----------
		function dispose() {
			disposed = true;
			var i;
			for (i = 0; i < timers.length; i++) clearInterval(timers[i]);
			timers = [];
			for (i = 0; i < observers.length; i++) observers[i].disconnect();
			observers = [];
			healObserver = null;
			window.removeEventListener("resize", onResize);
			if (popoverEl && popoverEl.parentElement) popoverEl.parentElement.removeChild(popoverEl);
			popoverEl = null;
			if (widgetEl && widgetEl.parentElement) widgetEl.parentElement.removeChild(widgetEl);
			widgetEl = null;
			var style = document.getElementById("as-style");
			if (style && style.parentElement) style.parentElement.removeChild(style);
			schedules = [];
			listSignature = "";
			listRefs = {};
			popOpen = false;
			dragState = null;
		}

		function mountWhenReady() {
			var mounted = false;
			var doMount = function () {
				if (mounted || disposed) return;
				if (!document.body) return;
				mounted = true;
				mountWidget();
				startSelfHeal();
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
				timers.push(setInterval(tick, TICK_MS));
				window.addEventListener("resize", onResize);
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
