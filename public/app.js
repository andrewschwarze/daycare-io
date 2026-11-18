const state = { user: null, children: [], families: [], events: [], selected: new Set(), correctionEvent: null };
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
  if (!["GET", "HEAD"].includes(method) && !["/api/login", "/api/setup", "/api/family-login", "/api/provider-recovery/complete"].includes(path)) {
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
  ["auth-view", "parent-view", "provider-view"].forEach((viewId) => {
    $(`#${viewId}`).classList.toggle("hidden", viewId !== id);
  });
  $("#logout-button").classList.toggle("hidden", id === "auth-view");
}

function showAuth(setupRequired = false, error = "") {
  ["#family-login-form", "#provider-login-form", "#provider-recovery-form", "#setup-form"].forEach((selector) => $(selector).classList.add("hidden"));
  $(setupRequired ? "#setup-form" : "#family-login-form").classList.remove("hidden");
  $("#auth-title").textContent = setupRequired ? "Set up provider account" : "Welcome back";
  $("#auth-subtitle").textContent = setupRequired ? "Create the provider's sign-in for this daycare." : "Enter your family's six-digit PIN.";
  $("#auth-error").textContent = error;
  $("#auth-error").classList.toggle("hidden", !error);
  setView("auth-view");
}

function showAdminRecoveryPhrase(phrase, title = "Provider recovery phrase") {
  $("#admin-recovery-title").textContent = title;
  $("#admin-recovery-phrase").textContent = phrase;
  $("#admin-recovery-ack-checkbox").checked = false;
  $("#admin-recovery-ack-button").disabled = true;
  $("#admin-recovery-dialog").showModal();
}

async function copyText(value, label) {
  try { await navigator.clipboard.writeText(value); showToast(`${label} copied.`); }
  catch { showToast(`Copy is unavailable. Select and copy the ${label.toLowerCase()} manually.`, 6000); }
}

async function createRecoveryPhrase(button) {
  button.disabled = true;
  try {
    const result = await api("/api/provider-recovery/rotate", { method: "POST", body: {} });
    showAdminRecoveryPhrase(result.recoveryPhrase, "Save the new provider recovery phrase");
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
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
  $("#action-hint").textContent = !chosen.length ? "Select a child to continue." : mixed ? "Some selected children have different attendance status. Uncheck the children not taking this action." : `${chosen.length} ${chosen.length === 1 ? "child" : "children"} selected.`;
  const allSelected = state.children.length > 0 && state.children.every((child) => state.selected.has(child.id));
  $("#select-all").textContent = allSelected ? "Deselect all" : "Select all";
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
  $("#family-child-options").innerHTML = activeChildren.length ? activeChildren.map((child) => `
    <label class="check-option"><input type="checkbox" name="childIds" value="${escapeHtml(child.id)}" /><span>${escapeHtml(child.first_name)} ${escapeHtml(child.last_name)}</span></label>`).join("") : '<span class="form-help">Add a child before creating a family.</span>';

  $("#family-list").innerHTML = state.families.length ? state.families.map((family) => {
    const childIds = String(family.child_ids || "").split(",").filter(Boolean);
    const childNames = childIds.map((id) => state.children.find((child) => child.id === id)).filter(Boolean).map((child) => `${child.first_name} ${child.last_name}`).join(", ");
    return `<div class="roster-row"><span class="avatar avatar-purple">${escapeHtml(initials(family.name))}</span><span class="child-meta"><strong>${escapeHtml(family.name)}${family.active ? "" : " · inactive"}</strong><small>${family.pin_set ? "PIN set" : "PIN needed"} · ${escapeHtml(childNames || "No children assigned")}</small></span><button class="row-action" type="button" data-edit-family="${escapeHtml(family.id)}">Edit</button>${family.active ? `<button class="row-action" type="button" data-reset-family="${escapeHtml(family.id)}">Generate new PIN</button><button class="row-action" type="button" data-revoke-family="${escapeHtml(family.id)}">Sign out devices</button>` : ""}<button class="row-action danger" type="button" data-toggle-family="${escapeHtml(family.id)}" data-active="${family.active}">${family.active ? "Deactivate" : "Reactivate"}</button></div>`;
  }).join("") : '<div class="empty-state">No families have been added yet.</div>';
  $("#family-list").querySelectorAll("[data-edit-family]").forEach((button) => button.addEventListener("click", () => editFamily(button.dataset.editFamily)));
  $("#family-list").querySelectorAll("[data-reset-family]").forEach((button) => button.addEventListener("click", () => resetFamilyPin(button.dataset.resetFamily)));
  $("#family-list").querySelectorAll("[data-revoke-family]").forEach((button) => button.addEventListener("click", () => revokeFamilyDevices(button.dataset.revokeFamily)));
  $("#family-list").querySelectorAll("[data-toggle-family]").forEach((button) => button.addEventListener("click", () => toggleFamily(button.dataset.toggleFamily, button.dataset.active === "1")));

  $("#activity-list").innerHTML = state.events.length ? state.events.map((event) => `
    <div class="activity-row"><span class="activity-dot ${event.correction_kind === "void" ? "void-dot" : ""}"></span>
      <span><strong>${escapeHtml(event.child_name)}</strong> ${event.correction_kind === "void" ? "event voided" : escapeHtml(event.effective_action === "sign_in" ? "signed in" : "signed out")} by ${escapeHtml(event.family_name)}${event.source === "provider" ? ` · recorded by ${escapeHtml(event.actor_name)}` : ""}${event.correction_actor ? ` · corrected by ${escapeHtml(event.correction_actor)}` : ""}${event.entry_reason ? `<small class="correction-reason">Provider entry: ${escapeHtml(event.entry_reason)}</small>` : ""}${event.correction_reason ? `<small class="correction-reason">Correction: ${escapeHtml(event.correction_reason)}</small>` : ""}</span>
      <small>${escapeHtml(formatTime(event.effective_at_utc))}</small><button class="row-action" type="button" data-correct-event="${escapeHtml(event.id)}">Correct</button>
      <details class="audit-details"><summary>Audit trail</summary><div>Original: ${escapeHtml(event.action === "sign_in" ? "sign in" : "sign out")} · ${escapeHtml(formatTime(event.occurred_at_utc))} · ${escapeHtml(event.actor_name)}</div>${event.correction_history.map((item) => `<div>${escapeHtml(item.kind)} · ${escapeHtml(item.reason)} · ${escapeHtml(item.actor)} · ${escapeHtml(formatTime(item.createdAtUtc))}</div>`).join("")}</details></div>`).join("") : '<div class="empty-state">No attendance events yet.</div>';
  $("#activity-list").querySelectorAll("[data-correct-event]").forEach((button) => button.addEventListener("click", () => openCorrection(button.dataset.correctEvent)));
}

async function refreshData(selectAllChildren = false) {
  const [children, events, families] = await Promise.all([
    api("/api/children"), api("/api/attendance"), state.user.role === "provider" ? api("/api/families") : Promise.resolve({ families: [] }),
  ]);
  state.children = children.children;
  state.events = events.events;
  state.families = families.families;
  state.selected = selectAllChildren
    ? new Set(state.children.map((child) => child.id))
    : new Set([...state.selected].filter((id) => state.children.some((child) => child.id === id)));
  if (state.user.role === "provider") renderProvider(); else renderParent();
}

async function enterApp(user) {
  state.user = user;
  $("#auth-error").classList.add("hidden");
  if (user.role === "provider" && user.recoveryAcknowledgementRequired) {
    setView("provider-view");
    try {
      const result = user.recoveryPhrase
        ? { recoveryPhrase: user.recoveryPhrase }
        : await api("/api/provider-recovery/rotate", { method: "POST", body: {} });
      showAdminRecoveryPhrase(result.recoveryPhrase, "Save the provider recovery phrase");
    } catch (error) {
      showAuth(false, `${error.message} Sign in again after resolving this issue.`);
    }
    return;
  }
  await refreshData(user.role === "family");
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
  const families = state.families.filter((family) => (child.present || family.active) && String(family.child_ids || "").split(",").includes(childId));
  if (!families.length) { showToast("Add an active family relationship before recording attendance."); return; }
  let family = families[0];
  if (families.length > 1) {
    const choices = families.map((item, index) => `${index + 1}. ${item.name}`).join("\n");
    const chosen = window.prompt(`Which family is this child checking in or out with?\n${choices}`, "1");
    if (chosen === null) return;
    const index = Number(chosen.trim()) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= families.length) { showToast("Choose one of the listed families."); return; }
    family = families[index];
  }
  const action = child.present ? "sign_out" : "sign_in";
  const reason = window.prompt(`Why is the provider recording this ${action === "sign_in" ? "sign-in" : "sign-out"}?`);
  if (!reason?.trim()) return;
  try {
    await api("/api/attendance/provider", { method: "POST", body: { childId, familyId: family.id, action, reason, requestId: crypto.randomUUID() } });
    await refreshData();
    showToast("Provider attendance entry recorded with a reason.");
  } catch (error) { showToast(error.message); }
}

async function editFamily(id) {
  const family = state.families.find((item) => item.id === id);
  if (!family) return;
  const name = window.prompt("Family name", family.name);
  if (name === null) return;
  const availableChildren = state.children.filter((child) => child.active);
  const currentChildren = String(family.child_ids || "").split(",").filter(Boolean).map((childId) => availableChildren.find((child) => child.id === childId)).filter(Boolean);
  const choices = availableChildren.map((child, index) => `${index + 1}. ${child.first_name} ${child.last_name}${currentChildren.some((item) => item.id === child.id) ? " ✓" : ""}`).join("\n");
  const selected = window.prompt(`Enter the numbers of children in this family, separated by commas.\n${choices}`, currentChildren.map((child) => availableChildren.indexOf(child) + 1).join(","));
  if (selected === null) return;
  const childIds = selected.split(",").map((value) => Number(value.trim()) - 1).filter((index) => Number.isInteger(index) && index >= 0 && index < availableChildren.length).map((index) => availableChildren[index].id);
  try {
    await api(`/api/families/${encodeURIComponent(id)}`, { method: "PATCH", body: { name } });
    await api(`/api/families/${encodeURIComponent(id)}/children`, { method: "PUT", body: { childIds } });
    await refreshData();
    showToast("Family details updated.");
  } catch (error) { showToast(error.message); }
}

async function toggleFamily(id, active) {
  const action = active ? "deactivate" : "reactivate";
  if (!window.confirm(`Are you sure you want to ${action} this family?`)) return;
  try {
    await api(`/api/families/${encodeURIComponent(id)}`, { method: "PATCH", body: { active: !active } });
    await refreshData();
    showToast(`Family ${active ? "deactivated" : "reactivated"}.`);
  } catch (error) { showToast(error.message); }
}

async function resetFamilyPin(id) {
  const family = state.families.find((item) => item.id === id);
  if (!family || !window.confirm(`Generate a new PIN for ${family.name}? Their current PIN and trusted devices will stop working.`)) return;
  try {
    const result = await api(`/api/families/${encodeURIComponent(id)}/reset-pin`, { method: "POST", body: {} });
    showFamilyPin(result, `${family.name} new PIN`);
  } catch (error) { showToast(error.message); }
}

async function revokeFamilyDevices(id) {
  const family = state.families.find((item) => item.id === id);
  if (!family || !window.confirm(`Sign out every trusted phone for ${family.name}?`)) return;
  try {
    const result = await api(`/api/families/${encodeURIComponent(id)}/revoke-sessions`, { method: "POST", body: {} });
    showToast(`${result.revokedCount} trusted device${result.revokedCount === 1 ? "" : "s"} signed out.`);
  } catch (error) { showToast(error.message); }
}

function showFamilyPin(result, title = "Family PIN") {
  $("#family-pin-title").textContent = title;
  $("#family-pin-value").textContent = result.pin;
  $("#family-pin-dialog").showModal();
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
  form.elements.familyId.innerHTML = state.families.map((family) => `<option value="${escapeHtml(family.id)}" ${family.id === event.effective_family_id ? "selected" : ""}>${escapeHtml(family.name)}${family.active ? "" : " (inactive)"}</option>`).join("");
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

$("#family-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    const result = await api("/api/family-login", { method: "POST", body: Object.fromEntries(data.entries()) });
    form.reset();
    await enterApp(result.user);
  } catch (error) {
    $("#auth-error").textContent = error.message;
    $("#auth-error").classList.remove("hidden");
  }
});

$("#provider-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    const result = await api("/api/login", { method: "POST", body: Object.fromEntries(data.entries()) });
    form.reset();
    await enterApp(result.user);
  } catch (error) {
    $("#auth-error").textContent = error.message;
    $("#auth-error").classList.remove("hidden");
  }
});

$("#show-provider-login").addEventListener("click", () => {
  showAuth(false);
  $("#family-login-form").classList.add("hidden");
  $("#provider-login-form").classList.remove("hidden");
  $("#auth-title").textContent = "Provider sign in";
  $("#auth-subtitle").textContent = "Enter your provider email and password.";
});
$("#back-to-family-login").addEventListener("click", () => showAuth(false));
$("#show-provider-recovery").addEventListener("click", () => {
  showAuth(false);
  $("#family-login-form").classList.add("hidden");
  $("#provider-recovery-form").classList.remove("hidden");
  $("#auth-title").textContent = "Recover provider access";
  $("#auth-subtitle").textContent = "Enter the recovery phrase saved during setup or replacement.";
});
$("#back-from-provider-recovery").addEventListener("click", () => {
  showAuth(false);
  $("#family-login-form").classList.add("hidden");
  $("#provider-login-form").classList.remove("hidden");
  $("#auth-title").textContent = "Provider sign in";
  $("#auth-subtitle").textContent = "Enter your provider email and password.";
});

$("#provider-recovery-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await api("/api/provider-recovery/complete", { method: "POST", body: Object.fromEntries(new FormData(form).entries()) });
    form.reset();
    const me = await api("/api/me");
    await enterApp({ ...me.user, recoveryAcknowledgementRequired: true, recoveryPhrase: result.recoveryPhrase });
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
    const setupResult = await api("/api/setup", { method: "POST", body: Object.fromEntries(data.entries()) });
    form.reset();
    await enterApp({ ...setupResult.user, recoveryAcknowledgementRequired: true, recoveryPhrase: setupResult.recoveryPhrase });
  } catch (error) {
    $("#auth-error").textContent = error.message;
    $("#auth-error").classList.remove("hidden");
  }
});

$("#provider-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  if (data.get("newPassword") !== data.get("confirmPassword")) { showToast("The passwords do not match."); return; }
  try {
    await api("/api/password", { method: "POST", body: Object.fromEntries(data.entries()) });
    form.reset();
    showToast("Password changed. Other provider devices were signed out.");
  } catch (error) { showToast(error.message); }
});

$("#provider-revoke-sessions").addEventListener("click", async () => {
  try {
    const result = await api("/api/provider-sessions/revoke-others", { method: "POST", body: {} });
    showToast(`${result.revokedCount} other provider session${result.revokedCount === 1 ? "" : "s"} signed out.`);
  } catch (error) { showToast(error.message); }
});

$("#admin-recovery-ack-checkbox").addEventListener("change", (event) => {
  $("#admin-recovery-ack-button").disabled = !event.target.checked;
});
$("#admin-recovery-ack-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/provider-recovery/ack", { method: "POST", body: {} });
    $("#admin-recovery-dialog").close();
    const me = await api("/api/me");
    await enterApp(me.user);
  } catch (error) { showToast(error.message); }
});
$("#admin-recovery-dialog").addEventListener("cancel", (event) => event.preventDefault());
$("#copy-admin-recovery-phrase").addEventListener("click", () => copyText($("#admin-recovery-phrase").textContent, "Recovery phrase"));

$("#logout-button").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST", body: {} }); } catch { /* session may have expired */ }
  state.user = null;
  state.children = [];
  state.events = [];
  state.families = [];
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

$("#add-family-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const childIds = data.getAll("childIds");
  try {
    const result = await api("/api/families", { method: "POST", body: { name: data.get("name"), childIds } });
    form.reset();
    showFamilyPin(result, `${result.name} PIN`);
    await refreshData();
  } catch (error) { showToast(error.message); }
});

$("#copy-family-pin").addEventListener("click", () => copyText($("#family-pin-value").textContent, "Family PIN"));
$("#close-family-pin").addEventListener("click", () => $("#family-pin-dialog").close());
$("#provider-recovery-button").addEventListener("click", (event) => createRecoveryPhrase(event.currentTarget));
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
        childId: data.get("childId"), familyId: data.get("familyId"),
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
$("#export-button").addEventListener("click", async (event) => {
  event.preventDefault();
  const button = event.currentTarget;
  button.setAttribute("aria-busy", "true");
  try {
    const response = await api("/api/export.csv", { raw: true });
    const downloadUrl = URL.createObjectURL(await response.blob());
    const download = document.createElement("a");
    download.href = downloadUrl;
    download.download = "attendance.csv";
    document.body.append(download);
    download.click();
    download.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    showToast("Attendance CSV downloaded.");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.removeAttribute("aria-busy");
  }
});
$("#copy-parent-link").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(`${window.location.origin}/`); showToast("Shared parent link copied."); }
  catch { showToast(`Parent check-in link: ${window.location.origin}/`, 12000); }
});
boot();
