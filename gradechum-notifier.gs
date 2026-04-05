/**
 * Grade Chum notifier.gs  (v7 — direct rank endpoint)
 * -------------------------------------------------------------
 * Changes in v7:
 *   - getRanking_() now uses the direct rank endpoint:
 *       GET /v1/tasks/{taskId}/students/rank/?section_id={sectionId}
 *     Response: { rank: 7, results_count: 40 }
 *     No more leaderboard list parsing — rank is returned directly.
 *   - CONFIG.RANKING_ENDPOINT set to the confirmed working pattern.
 *   - debugRanking() includes the correct endpoint in its probe list.
 *
 * HOW TO DEPLOY
 * -------------
 * 1. Paste this file into your Apps Script project
 * 2. Run debugFull() to confirm everything end-to-end
 * 3. Run setupTrigger() to start the watcher
 */

// ─── CONFIG ────────────────────────────────────────────────────────────────
var CONFIG = {
    GRADECHUM_EMAIL:    "",             // Your GradeChum login email
    GRADECHUM_PASSWORD: "",             // Your GradeChum password
    NOTIFY_TO:          "",             // Email address to receive notifications
  CHECK_INTERVAL_MIN: 15,
  TASKS_PAGE_SIZE:    50,

  // Direct rank endpoint — returns { rank, results_count } for a single student.
  // {taskId} and {sectionId} are replaced at runtime.
  RANKING_ENDPOINT: "https://backend.gradechum.com/v1/tasks/{taskId}/students/rank/?section_id={sectionId}",
};

var BACKEND = "https://backend.gradechum.com";
var APP     = "https://app.gradechum.com";

// ─── ENTRY POINT ───────────────────────────────────────────────────────────
function checkForNewResults() {
  Logger.log("=== GradeChum check: " + new Date() + " ===");

  var auth = login_();
  if (!auth) { Logger.log("Login failed. Aborting."); return; }

  var sections = getSections_(auth.token, auth.studentId);
  if (!sections.length) { Logger.log("No active sections found."); return; }
  Logger.log("Sections: " + sections.map(function(s) {
    return s.id + " (" + s.name + ")";
  }).join(", "));

  var allTasks = [];
  sections.forEach(function(s) {
    Utilities.sleep(800);
    allTasks = allTasks.concat(getSectionTasks_(auth.token, s.id, s.name));
  });

  var scoredTasks = allTasks.filter(function(t) { return t.score !== null; });
  Logger.log("Scored tasks: " + scoredTasks.length + " / " + allTasks.length);

  var seen   = loadSeen_();
  var newRes = scoredTasks.filter(function(t) { return !seen[t.id]; });

  if (newRes.length > 0) {
    Logger.log(newRes.length + " new results. Fetching rankings…");

    newRes = newRes.map(function(r) {
      var ranking = getRanking_(auth.token, r.sectionId, r.taskId);
      r.rank  = ranking.rank;
      r.total = ranking.total;
      return r;
    });

    sendEmail_(newRes);
  } else {
    Logger.log("No new results since last check.");
  }

  scoredTasks.forEach(function(t) { seen[t.id] = true; });
  saveSeen_(seen);
}

// ─── AUTH ──────────────────────────────────────────────────────────────────
function login_() {
  try {
    var resp = UrlFetchApp.fetch(BACKEND + "/v1/tokens/acquire/", {
      method:      "post",
      contentType: "application/json",
      payload:     JSON.stringify({
        email:    CONFIG.GRADECHUM_EMAIL,
        password: CONFIG.GRADECHUM_PASSWORD,
      }),
      muteHttpExceptions: true,
    });

    var code = resp.getResponseCode();
    Logger.log("POST /v1/tokens/acquire/ → HTTP " + code);
    if (code !== 200 && code !== 201) {
      Logger.log("Auth failed: " + resp.getContentText().substring(0, 200));
      return null;
    }

    var body  = safeJson_(resp.getContentText());
    var token = body && (body.access_token || body.access || body.token);
    if (!token) { Logger.log("No token in response."); return null; }

    // Decode student ID from JWT payload
    var studentId = null;
    try {
      var padded  = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (padded.length % 4) padded += "=";
      var payload = safeJson_(Utilities.newBlob(
        Utilities.base64Decode(padded)
      ).getDataAsString());
      studentId = payload && String(payload.user_id || payload.sub || payload.id);
      Logger.log("Student ID from JWT: " + studentId);
    } catch (e) {
      Logger.log("JWT decode error: " + e);
    }

    if (!studentId) { Logger.log("Could not extract student ID."); return null; }
    return { token: token, studentId: studentId };

  } catch (e) {
    Logger.log("Login error: " + e);
    return null;
  }
}

function bearerHeaders_(token) {
  return { "Authorization": "Bearer " + token, "Content-Type": "application/json" };
}

// ─── SECTIONS ──────────────────────────────────────────────────────────────
function getSections_(token, studentId) {
  var url = BACKEND + "/v1/sections/extended/?is_active=true&page=1&has_student_id=" + studentId;
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: "get", headers: bearerHeaders_(token), muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) return [];
    var body = safeJson_(resp.getContentText());
    var list = body && (body.results || body.data || body);
    if (!Array.isArray(list)) return [];
    return list.map(function(s) {
      return { id: s.id, name: s.name || ("Section " + s.id) };
    });
  } catch (e) {
    Logger.log("Sections error: " + e);
    return [];
  }
}

// ─── TASKS PER SECTION ─────────────────────────────────────────────────────
function getSectionTasks_(token, sectionId, sectionName) {
  var url = BACKEND + "/v1/sections/" + sectionId
          + "/tasks/student/?page=1&page_size=" + CONFIG.TASKS_PAGE_SIZE;
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: "get", headers: bearerHeaders_(token), muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) return [];
    var body = safeJson_(resp.getContentText());
    var list = body && (body.results || body.data || body);
    if (!Array.isArray(list)) return [];

    return list.map(function(task) {
      var released = task.has_result === true && task.task_release !== null;
      var score    = released ? task.score     : null;
      var maxScore = released ? task.max_score : null;
      var pct      = (released && maxScore > 0)
                     ? Math.round((score / maxScore) * 100) : null;

      return {
        id:        "s" + sectionId + "_t" + task.id,
        taskId:    task.id,
        sectionId: sectionId,
        section:   sectionName,
        title:     task.name || "Untitled",
        score:     score,
        maxScore:  maxScore,
        pct:       pct,
        scoreStr:  released ? (score + " / " + maxScore) : null,
        pctStr:    pct !== null ? (pct + "%") : null,
        link:      APP + "/student/classes/" + sectionId + "/activities",
      };
    });
  } catch (e) {
    Logger.log("Tasks error for section " + sectionId + ": " + e);
    return [];
  }
}

// ─── RANKING ───────────────────────────────────────────────────────────────
/**
 * Fetches rank directly from:
 *   GET /v1/tasks/{taskId}/students/rank/?section_id={sectionId}
 * Response: { rank: 7, results_count: 40 }
 *
 * Returns { rank, total } or { rank: null, total: null } on failure.
 */
function getRanking_(token, sectionId, taskId) {
  if (!CONFIG.RANKING_ENDPOINT) return { rank: null, total: null };

  var url = CONFIG.RANKING_ENDPOINT
    .replace("{taskId}",    taskId)
    .replace("{sectionId}", sectionId);

  try {
    var resp = UrlFetchApp.fetch(url, {
      method: "get", headers: bearerHeaders_(token), muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    Logger.log("Ranking GET " + url + " → HTTP " + code);
    if (code !== 200) return { rank: null, total: null };

    var body = safeJson_(resp.getContentText());
    if (!body) return { rank: null, total: null };

    // Expected shape: { rank: 7, results_count: 40 }
    var rank  = body.rank          != null ? body.rank          : null;
    var total = body.results_count != null ? body.results_count : null;

    Logger.log("Rank: " + rank + " / " + total);
    return { rank: rank, total: total };

  } catch (e) {
    Logger.log("Ranking error: " + e);
    return { rank: null, total: null };
  }
}

// ─── EMAIL ─────────────────────────────────────────────────────────────────
function sendEmail_(newResults) {
  var rows = newResults.map(function(r) {
    var rankStr = (r.rank !== null && r.total !== null)
                  ? ("#" + r.rank + " of " + r.total) : "—";

    var scoreCell = "<td style='padding:8px 12px;border:1px solid #ddd;font-weight:bold'>"
                  + r.scoreStr + "</td>";
    var pctCell   = "<td style='padding:8px 12px;border:1px solid #ddd;color:"
                  + pctColor_(r.pct) + ";font-weight:bold'>" + (r.pctStr || "—") + "</td>";
    var rankCell  = "<td style='padding:8px 12px;border:1px solid #ddd'>" + rankStr + "</td>";
    var linkCell  = "<td style='padding:8px 12px;border:1px solid #ddd'>"
                  + "<a href='" + r.link + "' style='color:#2d6a4f'>View →</a></td>";

    return "<tr>"
      + "<td style='padding:8px 12px;border:1px solid #ddd'>" + r.section + "</td>"
      + "<td style='padding:8px 12px;border:1px solid #ddd'>" + r.title   + "</td>"
      + scoreCell + pctCell + rankCell + linkCell
      + "</tr>";
  }).join("");

  var html = "<html><body style='font-family:sans-serif;color:#222'>"
    + "<h2 style='color:#2d6a4f'>New GradeChum Results Available</h2>"
    + "<p>" + newResults.length + " new results just released:</p>"
    + "<table style='border-collapse:collapse;width:100%'>"
    + "<thead><tr style='background:#2d6a4f;color:#fff'>"
    + "<th style='padding:8px 12px'>Class</th>"
    + "<th style='padding:8px 12px'>Assessment</th>"
    + "<th style='padding:8px 12px'>Score</th>"
    + "<th style='padding:8px 12px'>Percentage</th>"
    + "<th style='padding:8px 12px'>Rank</th>"
    + "<th style='padding:8px 12px'>Link</th>"
    + "</tr></thead><tbody>" + rows + "</tbody></table>"
    + "<p style='font-size:12px;color:#888'>Sent by grade_chum_Notifier.gs · checks every "
    + CONFIG.CHECK_INTERVAL_MIN + " min</p>"
    + "</body></html>";

  MailApp.sendEmail({
    to:       CONFIG.NOTIFY_TO,
    subject:  "GradeChum: " + newResults.length + " new results released!",
    htmlBody: html,
    name:     "Grade Chum Notifier",
  });
  Logger.log("Email sent to " + CONFIG.NOTIFY_TO);
}

/** Returns a color string based on percentage score */
function pctColor_(pct) {
  if (pct === null) return "#222";
  if (pct >= 90)   return "#2d6a4f"; // green
  if (pct >= 75)   return "#f4a261"; // orange
  return "#e63946";                  // red
}

// ─── STATE ─────────────────────────────────────────────────────────────────
function loadSeen_() {
  var raw = PropertiesService.getUserProperties().getProperty("seen_results");
  return raw ? JSON.parse(raw) : {};
}
function saveSeen_(seen) {
  PropertiesService.getUserProperties()
    .setProperty("seen_results", JSON.stringify(seen));
}

// ─── TRIGGER ───────────────────────────────────────────────────────────────
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "checkForNewResults") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("checkForNewResults")
    .timeBased().everyMinutes(CONFIG.CHECK_INTERVAL_MIN).create();
  Logger.log("Trigger set: every " + CONFIG.CHECK_INTERVAL_MIN + " min.");
}
function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) { ScriptApp.deleteTrigger(t); });
  Logger.log("All triggers removed.");
}

// ─── DEBUG ─────────────────────────────────────────────────────────────────

/**
 * Probes ranking endpoint candidates against task 12993 / section 4759.
 * The confirmed working one is already in CONFIG.RANKING_ENDPOINT.
 */
function debugRanking() {
  Logger.log("=== DEBUG: Ranking endpoint probe ===");
  var auth = login_();
  if (!auth) { Logger.log("Login failed."); return; }

  var sectionId = "4759";
  var taskId    = "12993";

  var candidates = [
    // Confirmed working endpoint (direct rank, no leaderboard list needed)
    BACKEND + "/v1/tasks/" + taskId + "/students/rank/?section_id=" + sectionId,
    // Legacy candidates kept for reference
    BACKEND + "/v1/sections/" + sectionId + "/tasks/" + taskId + "/results/",
    BACKEND + "/v1/sections/" + sectionId + "/tasks/" + taskId + "/leaderboard/",
    BACKEND + "/v1/sections/" + sectionId + "/tasks/" + taskId + "/ranking/",
    BACKEND + "/v1/tasks/" + taskId + "/results/",
    BACKEND + "/v1/tasks/" + taskId + "/leaderboard/",
    BACKEND + "/v1/results/?task_id=" + taskId,
  ];

  candidates.forEach(function(url) {
    try {
      var resp = UrlFetchApp.fetch(url, {
        method: "get", headers: bearerHeaders_(auth.token), muteHttpExceptions: true,
      });
      var code = resp.getResponseCode();
      var preview = resp.getContentText().substring(0, 150);
      Logger.log("HTTP " + code + " | " + url);
      if (code === 200) Logger.log("  ✓ " + preview);
    } catch (e) {
      Logger.log("ERR | " + url + " | " + e);
    }
  });
}

/** Full end-to-end test. */
function debugFull() {
  Logger.log("=== FULL DEBUG ===");
  var auth = login_();
  if (!auth) { Logger.log("Login failed."); return; }
  Logger.log("Token OK. Student ID: " + auth.studentId);

  var sections = getSections_(auth.token, auth.studentId);
  Logger.log("Sections (" + sections.length + "):");
  sections.forEach(function(s) { Logger.log("  " + s.id + " → " + s.name); });

  var allTasks = [];
  sections.forEach(function(s) {
    var tasks  = getSectionTasks_(auth.token, s.id, s.name);
    var scored = tasks.filter(function(t) { return t.score !== null; });
    Logger.log("  Section " + s.id + ": " + tasks.length + " tasks, " + scored.length + " scored");
    allTasks = allTasks.concat(tasks);
  });

  var scored = allTasks.filter(function(t) { return t.score !== null; });
  Logger.log("\nTotal scored: " + scored.length);

  scored = scored.map(function(r) {
    var ranking = getRanking_(auth.token, r.sectionId, r.taskId);
    r.rank  = ranking.rank;
    r.total = ranking.total;
    return r;
  });

  Logger.log(JSON.stringify(scored, null, 2));
}

function safeJson_(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

/**
 * sendTestEmail()
 * ---------------
 * Sends a sample email using fake data so you can preview the email layout
 * without waiting for a real result to be released.
 * Run this once manually — no trigger needed.
 */
function sendTestEmail() {
  var fakeResults = [
    {
      section:  "ARCH264 - R7",
      title:    "Midterm Exam",
      score:    39,
      maxScore: 50,
      pct:      78,
      scoreStr: "39 / 50",
      pctStr:   "78%",
      rank:     7,
      total:    40,
      link:     APP + "/student/classes/4759/activities",
    },
    {
      section:  "ARCH162_R8 2s25-26",
      title:    "Midterm Exam",
      score:    null,
      maxScore: 100,
      pct:      null,
      scoreStr: "— / 100",
      pctStr:   "—",
      rank:     null,
      total:    null,
      link:     APP + "/student/classes/4338/activities",
    },
  ];

  sendEmail_(fakeResults);
  Logger.log("Test email sent to " + CONFIG.NOTIFY_TO);
}
