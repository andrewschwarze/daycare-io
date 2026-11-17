const state = { user: null, children: [], guardians: [], events: [], selected: new Set(), correctionEvent: null };
let toastTimer;

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function readCookie(name) {
  const entry = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : "";
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD"].includes(method) && !["/api/login", "/api/setup"].includes(path)) {
    headers.set("X-CSRF-Token", readCookie("daycare_csrf"));
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    let message = "The request could not be completed.";
    try { message = (await response.json()).error || message; } catch { /* keep generic error */ }
    throw new Error(message);
  }
  if (options.raw) return response;
  return response.status === 204 ? null : response.json();
}

function showToast(message, duration = 3200) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), duration);
}

function setView(id) {
  ["auth-view", "password-view", "parent-view", "provider-view"].forEach((viewId) => {
    $(`#${viewId}`).classList.toggle("hidden", viewId !== id);
  });
  $("#logout-button").classList.toggle("hidden", id === "auth-view");
}

function showAuth(setupRequired = false, error = "") {
  $("#login-form").classList.toggle("hidden", setupRequired);
  $("#setup-form").classList.toggle("hidden", !setupRequired);
  $("#auth-title").textContent = setupRequired ? "Set up provider account" : "Welcome back";
  $("#auth-subtitle").textContent = setupRequired ? "Create the first provider login for this daycare." : "Sign in to manage attendance.";
  $("#auth-error").textContent = error;
  $("#auth-error").classList.toggle("hidden", !error);
  setView("auth-view");
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
  }).format(new Date(value));
}

function centralDateTimeInput(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value)).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function centralDateTimeToUtc(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Enter a valid date and time.");
  const [, y, mo, d, h, mi] = match.map(Number);
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let count = 0; count < 3; count += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(guess)).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const adjustment = target - represented;
    guess += adjustment;
    if (adjustment === 0) break;
  }
  if (centralDateTimeInput(new Date(guess).toISOString()) !== value) throw new Error("That Central Time does not exist because of a daylight-saving clock change.");
  return new Date(guess).toISOString();
}

function todayLabel() {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "America/Chicago",
  }).format(new Date()).toUpperCase().replace(",", " ·");
}

function initials(name) {
  return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

function avatarClass(name) {
  const colors = ["avatar-mint", "avatar-peach", "avatar-blue", "avatar-purple"];
  return colors[(String(name).length + String(name).charCodeAt(0)) % colors.length];
}

function localDate(value) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function renderParent() {
  $("#today-label").textContent = todayLabel();
  $("#parent-greeting").textContent = `Hello, ${state.user.name.split(" ")[0]}`;
  $("#parent-name").textContent = state.user.name;
  $("#parent-avatar").textContent = initials(state.user.name);
  const list = $("#child-list");
  if (!state.children.length) {
    list.innerHTML = '<div class="empty-state">No children are linked to your account yet. Ask the provider to check your access.</div>';
  } else {
    list.innerHTML = state.children.map((child) => `
      <button class="child-card ${state.selected.has(child.id) ? "selected" : ""}" type="button" data-child-id="${escapeHtml(child.id)}" aria-pressed="${state.selected.has(child.id)}">
        <span class="avatar ${avatarClass(child.first_name)}">${escapeHtml(initials(`${child.first_name} ${child.last_name}`))}</span>
        <span class="child-meta"><strong>${escapeHtml(child.first_name)} ${escapeHtml(child.last_name)}</strong><small>${child.present ? `Checked in ${escapeHtml(formatTime(child.last_event_at_utc))}` : "Not checked in yet"}</small></span>
        <span class="status ${child.present ? "status-present" : "status-home"}">${child.present ? "At daycare" : "Not checked in"}</span>
        <span class="check-box" aria-hidden="true">${state.selected.has(child.id) ? "✓" : ""}</span>
      </button>`).join("");
    list.querySelectorAll("[data-child-id]").forEach((button) => button.addEventListener("click", () => {
      const id = button.dataset.childId;
      state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
      renderParent();
    }));
  }
  updateAction();
}

function updateAction() {
  const chosen = state.children.filter((child) => state.selected.has(child.id));
  const actionButton = $("#attendance-action");
  const mixed = chosen.some((child) => child.present !== chosen[0]?.present);
  actionButton.textContent = chosen[0]?.present ? "Sign out selected" : "Sign in selected";
  actionButton.disabled = chosen.length === 0 || mixed;
  $("#action-hint").textContent = !chosen.length ? "Select a child to continue." : mixed ? "Select children with the same attendance status." : `${chosen.length} ${chosen.length === 1 ? "child" : "children"} selected.`;
}

function renderProvider() {
  const present = state.children.filter((child) => child.present);
  const today = localDate(new Date());
  const arrivals = state.events.filter((event) => event.correction_kind !== "void" && event.effective_action === "sign_in" && localDate(event.effective_at_utc) === today).length;
  $("#provider-greeting").textContent = `Hello, ${state.user.name.split(" ")[0]}`;
  $("#parent-entry-url").textContent = `${window.location.origin}/`;
  $("#present-count").textContent = String(present.length);
  $("#arrival-count").textContent = String(arrivals);
  $("#missing-count").textContent = String(present.length);

  $("#provider-roster").innerHTML = state.children.length ? state.children.map((child) => `
    <div class="roster-row"><span class="avatar ${avatarClass(child.first_name)}">${escapeHtml(initials(`${child.first_name} ${child.last_name}`))}</span>
      <span class="child-meta"><strong>${escapeHtml(child.first_name)} ${escapeHtml(child.last_name)}</strong><small>${child.present ? `Present since ${escapeHtml(formatTime(child.last_event_at_utc))}` : "Not currently present"}</small></span>
      <span class="status ${!child.active ? "status-home" : child.present ? "status-present" : "status-home"}">${!child.active ? "Inactive" : child.present ? "Present" : "Away"}</span>
      ${child.present || child.active ? `<button class="row-action" type="button" data-provider-attendance="${escapeHtml(child.id)}">${child.present ? "Record sign-out" : "Record sign-in"}</button>` : ""}
      <button class="row-action" type="button" data-edit-child="${escapeHtml(child.id)}">Edit</button><button class="row-action danger" type="button" data-toggle-child="${escapeHtml(child.id)}" data-active="${child.active}">${child.active ? "Deactivate" : "Reactivate"}</button></div>`).join("") : '<div class="empty-state">No children have been added yet.</div>';
  $("#provider-roster").querySelectorAll("[data-edit-child]").forEach((button) => button.addEventListener("click", () => editChild(button.dataset.editChild)));
  $("#provider-roster").querySelectorAll("[data-toggle-child]").forEach((button) => button.addEventListener("click", () => toggleChild(button.dataset.toggleChild, button.dataset.active === "1")));
  $("#provider-roster").querySelectorAll("[data-provider-attendance]").forEach((button) => button.addEventListener("click", () => providerAttendance(button.dataset.providerAttendance)));

  const activeChildren = state.children.filter((child) => child.active);
  $("#child-access-options").innerHTML = activeChildren.length ? activeChildren.map((child) => `
    <label class="check-option"><input type="checkbox" name="childIds" value="${escapeHtml(child.id)}" /><span>${escapeHtml(child.first_name)} ${escapeHtml(child.last_name)}</span></label>`).join("") : '<span class="form-help">Add a child before creating a guardian.</span>';

  $("#guardian-list").innerHTML = state.guardians.length ? state.guardians.map((guardian) => {
    const childIds = String(guardian.child_ids || "").split(",").filter(Boolean);
    const childNames = childIds.map((id) => state.children.find((child) => child.id === id)).filter(Boolean).map((child) => `${child.first_name} ${child.last_name}`).join(", ");
    return `<div class="roster-row"><span class="avatar avatar-purple">${escapeHtml(initials(guardian.name))}</span><span class="child-meta"><strong>${escapeHtml(guardian.name)}${guardian.active ? "" : " · inactive"}</strong><small>${escapeHtml(guardian.email)} · ${escapeHtml(childNames || "No child access")}</small></span><button class="row-action" type="button" data-edit-guardian="${escapeHtml(guardian.id)}">Edit</button><button class="row-action danger" type="button" data-toggle-guardian="${escapeHtml(guardian.id)}" data-active="${guardian.active}">${guardian.active ? "Deactivate" : "Reactivate"}</button></div>`;
  }).join("") : '<div class="empty-state">No guardians have been added yet.</div>';
  $("#guardian-list").querySelectorAll("[data-edit-guardian]").forEach((button) => button.addEventListener("click", () => editGuardian(button.dataset.editGuardian)));
  $("#guardian-list").querySelectorAll("[data-toggle-guardian]").forEach((button) => button.addEventListener("click", () => toggleGuardian(button.dataset.toggleGuardian, button.dataset.active === "1")));

  $("#activity-list").innerHTML = state.events.length ? state.events.map((event) => `
    <div class="activity-row"><span class="activity-dot ${event.correction_kind === "void" ? "void-dot" : ""}"></span>
      <span><strong>${escapeHtml(event.child_name)}</strong> ${event.correction_kind === "void" ? "event voided" : escapeHtml(event.effective_action === "sign_in" ? "signed in" : "signed out")} by ${escapeHtml(event.guardian_name)}${event.source === "provider" ? ` · recorded by ${escapeHtml(event.actor_name)}` : ""}${event.correction_actor ? ` · corrected by ${escapeHtml(event.correction_actor)}` : ""}${event.entry_reason ? `<small class="correction-reason">Provider entry: ${escapeHtml(event.entry_reason)}</small>` : ""}${event.correction_reason ? `<small class="correction-reason">Correction: ${escapeHtml(event.correction_reason)}</small>` : ""}</span>
      <small>${escapeHtml(formatTime(event.effective_at_utc))}</small><button class="row-action" type="button" data-correct-event="${escapeHtml(event.id)}">Correct</button>
      <details class="audit-details"><summary>Audit trail</summary><div>Original: ${escapeHtml(event.action === "sign_in" ? "sign in" : "sign out")} · ${escapeHtml(formatTime(event.occurred_at_utc))} · ${escapeHtml(event.actor_name)}</div>${event.correction_history.map((item) => `<div>${escapeHtml(item.kind)} · ${escapeHtml(item.reason)} · ${escapeHtml(item.actor)} · ${escapeHtml(formatTime(item.createdAtUtc))}</div>`).join("")}</details></div>`).join("") : '<div class="empty-state">No attendance events yet.</div>';
  $("#activity-list").querySelectorAll("[data-correct-event]").forEach((button) => button.addEventListener("click", () => openCorrection(button.dataset.correctEvent)));
}

async function refreshData() {
  const [children, events, guardians] = await Promise.all([
    api("/api/children"), api("/api/attendance"), state.user.role === "provider" ? api("/api/guardians") : Promise.resolve({ guardians: [] }),
  ]);
  state.children = children.children;
  state.events = events.events;
  state.guardians = guardians.guardians;
  if (state.user.role === "provider") renderProvider(); else renderParent();
}

async function enterApp(user) {
  state.user = user;
  $("#auth-error").classList.add("hidden");
  if (user.mustChangePassword) { setView("password-view"); return; }
  await refreshData();
  setView(user.role === "provider" ? "provider-view" : "parent-view");
}

async function editChild(id) {
  const child = state.children.find((item) => item.id === id);
  if (!child) return;
  const firstName = window.prompt("Child first name", child.first_name);
  if (firstName === null) return;
  const lastName = window.prompt("Child last name", child.last_name);
  if (lastName === null) return;
  try {
    await api(`/api/children/${encodeURIComponent(id)}`, { method: "PATCH", body: { firstName, lastName } });
    await refreshData();
    showToast("Child details updated.");
  } catch (error) { showToast(error.message); }
}

async function toggleChild(id, active) {
  const child = state.children.find((item) => item.id === id);
  if (!child) return;
  const action = active ? "deactivate" : "reactivate";
  if (!window.confirm(`Are you sure you want to ${action} ${child.first_name} ${child.last_name}?`)) return;
  try {
    await api(`/api/children/${encodeURIComponent(id)}`, { method: "PATCH", body: { active: !active } });
    await refreshData();
    showToast(`Child ${active ? "deactivated" : "reactivated"}.`);
  } catch (error) { showToast(error.message); }
}

async function providerAttendance(childId) {
  const child = state.children.find((item) => item.id === childId);
  if (!child) return;
  const guardians = state.guardians.filter((guardian) => (child.present || guardian.active) && String(guardian.child_ids || "").split(",").includes(childId));
  if (!guardians.length) { showToast("Add an active guardian relationship before recording attendance."); return; }
  let guardian = guardians[0];
  if (guardians.length > 1) {
    const choices = guardians.map((item, index) => `${index + 1}. ${item.name}`).join("\n");
    const chosen = window.prompt(`Which adult is dropping off or picking up ${child.first_name}?\n${choices}`, "1");
    if (chosen === null) return;
    const index = Number(chosen.trim()) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= guardians.length) { showToast("Choose one of the listed adults."); return; }
    guardian = guardians[index];
  }
  const action = child.present ? "sign_out" : "sign_in";
  const reason = window.prompt(`Why is the provider recording this ${action === "sign_in" ? "sign-in" : "sign-out"}?`);
  if (!reason?.trim()) return;
  try {
    await api("/api/attendance/provider", { method: "POST", body: { childId, guardianId: guardian.id, action, reason, requestId: crypto.randomUUID() } });
    await refreshData();
    showToast("Provider attendance entry recorded with a reason.");
  } catch (error) { showToast(error.message); }
}

async function editGuardian(id) {
  const guardian = state.guardians.find((item) => item.id === id);
  if (!guardian) return;
  const name = window.prompt("Guardian name", guardian.name);
  if (name === null) return;
  const email = window.prompt("Guardian email", guardian.email);
  if (email === null) return;
  const availableChildren = state.children.filter((child) => child.active);
  const currentChildren = String(guardian.child_ids || "").split(",").filter(Boolean).map((childId) => availableChildren.find((child) => child.id === childId)).filter(Boolean);
  const choices = availableChildren.map((child, index) => `${index + 1}. ${child.first_name} ${child.last_name}${currentChildren.some((item) => item.id === child.id) ? " ✓" : ""}`).join("\n");
  const selected = window.prompt(`Enter the numbers of children this guardian may manage, separated by commas.\n${choices}`, currentChildren.map((child) => availableChildren.indexOf(child) + 1).join(","));
  if (selected === null) return;
  const childIds = selected.split(",").map((value) => Number(value.trim()) - 1).filter((index) => Number.isInteger(index) && index >= 0 && index < availableChildren.length).map((index) => availableChildren[index].id);
  try {
    await api(`/api/guardians/${encodeURIComponent(id)}`, { method: "PATCH", body: { name, email } });
    await api(`/api/guardians/${encodeURIComponent(id)}/children`, { method: "PUT", body: { childIds } });
    await refreshData();
    showToast("Guardian details and access updated.");
  } catch (error) { showToast(error.message); }
}

async function toggleGuardian(id, active) {
  const action = active ? "deactivate" : "reactivate";
  if (!window.confirm(`Are you sure you want to ${action} this guardian account?`)) return;
  try {
    await api(`/api/guardians/${encodeURIComponent(id)}`, { method: "PATCH", body: { active: !active } });
    await refreshData();
    showToast(`Guardian account ${active ? "deactivated" : "reactivated"}.`);
  } catch (error) { showToast(error.message); }
}

function openCorrection(eventId) {
  const event = state.events.find((item) => item.id === eventId);
  if (!event) return;
  state.correctionEvent = event;
  const form = $("#correction-form");
  form.elements.eventId.value = event.id;
  form.elements.kind.value = "replace";
  form.elements.action.value = event.effective_action;
  form.elements.occurredAt.value = centralDateTimeInput(event.effective_at_utc);
  form.elements.reason.value = "";
  form.elements.childId.innerHTML = state.children.map((child) => `<option value="${escapeHtml(child.id)}" ${child.id === event.effective_child_id ? "selected" : ""}>${escapeHtml(child.first_name)} ${escapeHtml(child.last_name)}</option>`).join("");
  form.elements.guardianId.innerHTML = state.guardians.filter((guardian) => guardian.active).map((guardian) => `<option value="${escapeHtml(guardian.id)}" ${guardian.id === event.effective_guardian_id ? "selected" : ""}>${escapeHtml(guardian.name)}</option>`).join("");
  $("#replacement-fields").classList.remove("hidden");
  $("#correction-dialog").showModal();
}

async function boot() {
  try {
    const result = await api("/api/me");
    await enterApp(result.user);
  } catch {
    try {
      const setup = await api("/api/setup-status");
      showAuth(setup.setupRequired);
    } catch { showAuth(false, "The app could not connect to its local database. Apply the local D1 migration and reload."); }
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    const result = await api("/api/login", { method: "POST", body: { email: data.get("email"), password: data.get("password") } });
    form.reset();
    await enterApp(result.user);
  } catch (error) {
    $("#auth-error").textContent = error.message;
    $("#auth-error").classList.remove("hidden");
  }
});

$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    await api("/api/setup", { method: "POST", body: Object.fromEntries(data.entries()) });
    form.reset();
    const result = await api("/api/me");
    await enterApp(result.user);
  } catch (error) {
    $("#auth-error").textContent = error.message;
    $("#auth-error").classList.remove("hidden");
  }
});

$("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    await api("/api/password", { method: "POST", body: Object.fromEntries(data.entries()) });
    form.reset();
    await enterApp({ ...state.user, mustChangePassword: false });
    showToast("Password changed.");
  } catch (error) {
    $("#password-error").textContent = error.message;
    $("#password-error").classList.remove("hidden");
  }
});

$("#logout-button").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST", body: {} }); } catch { /* session may have expired */ }
  state.user = null;
  state.children = [];
  state.events = [];
  state.guardians = [];
  showAuth(false);
});

$("#attendance-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const selected = state.children.filter((child) => state.selected.has(child.id));
  if (!selected.length) return;
  const action = selected[0].present ? "sign_out" : "sign_in";
  const button = $("#attendance-action");
  button.disabled = true;
  try {
    await api("/api/attendance/batch", { method: "POST", body: { childIds: selected.map((child) => child.id), action, requestId: crypto.randomUUID() } });
    state.selected.clear();
    await refreshData();
    showToast(`${selected.length === 1 ? selected[0].first_name : `${selected.length} children`} ${action === "sign_in" ? "signed in" : "signed out"}.`);
  } catch (error) {
    state.selected.clear();
    await refreshData();
    showToast(error.message);
  }
});

$("#select-all").addEventListener("click", () => {
  const eligible = state.children;
  state.selected = eligible.every((child) => state.selected.has(child.id)) ? new Set() : new Set(eligible.map((child) => child.id));
  renderParent();
});

$("#add-child-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    await api("/api/children", { method: "POST", body: { firstName: data.get("firstName"), lastName: data.get("lastName") } });
    form.reset();
    await refreshData();
    showToast("Child added.");
  } catch (error) { showToast(error.message); }
});

$("#add-guardian-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const childIds = data.getAll("childIds");
  try {
    const result = await api("/api/guardians", { method: "POST", body: { name: data.get("name"), email: data.get("email"), childIds } });
    form.reset();
    $("#temporary-password").textContent = result.temporaryPassword;
    $("#temporary-password-dialog").showModal();
    await refreshData();
  } catch (error) { showToast(error.message); }
});

$("#copy-temporary-password").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#temporary-password").textContent); showToast("Temporary password copied."); }
  catch { showToast("Copy is unavailable. Select and copy the password manually."); }
});
$("#close-temporary-password").addEventListener("click", () => $("#temporary-password-dialog").close());
$("#close-correction").addEventListener("click", () => $("#correction-dialog").close());
$("#correction-form").elements.kind.addEventListener("change", (event) => $("#replacement-fields").classList.toggle("hidden", event.target.value === "void"));

$("#correction-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const body = { kind: data.get("kind"), reason: data.get("reason") };
  if (body.kind === "replace") {
    try {
      Object.assign(body, {
        childId: data.get("childId"), guardianId: data.get("guardianId"),
        action: data.get("action"), occurredAtUtc: centralDateTimeToUtc(data.get("occurredAt")),
      });
    } catch (error) { showToast(error.message); return; }
  }
  try {
    await api(`/api/attendance/${encodeURIComponent(data.get("eventId"))}/corrections`, { method: "POST", body });
    $("#correction-dialog").close();
    await refreshData();
    showToast("Correction saved. The original event is preserved.");
  } catch (error) { showToast(error.message); }
});

$("#print-button").addEventListener("click", () => window.print());
$("#copy-parent-link").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(`${window.location.origin}/`); showToast("Shared parent link copied."); }
  catch { showToast(`Parent check-in link: ${window.location.origin}/`, 12000); }
});
boot();
