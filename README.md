# GradeChum Notifier

A Google Apps Script that watches [GradeChum](https://app.gradechum.com) for newly released assessment results and emails you the moment scores drop — including your score, percentage, and class rank.

## How it works

The script runs on a time-based trigger (every 15 minutes by default). It logs into GradeChum using your credentials, fetches tasks across all your active sections, and compares them against a stored snapshot. When new scored results are detected, it sends a formatted HTML email showing each assessment's score, percentage (color-coded), and rank within your section.

## Setup

### 1. Create a Google Apps Script project

Go to [script.google.com](https://script.google.com), create a new project, and paste the contents of `gradechum-notifier.gs` into the editor.

### 2. Configure your credentials

At the top of the script, fill in the `CONFIG` object:

```js
var CONFIG = {
  GRADECHUM_EMAIL:    "your@email.com",
  GRADECHUM_PASSWORD: "yourpassword",
  NOTIFY_TO:          "notify@email.com",
  CHECK_INTERVAL_MIN: 15,
  ...
};
```

> ⚠️ **Do not share this file with your credentials filled in.** Your password is stored in plaintext inside the script. Keep the project private, or move credentials to [Script Properties](https://developers.google.com/apps-script/guides/properties) instead.

### 3. Test it

Run `debugFull()` from the editor to verify login, section fetching, task fetching, and ranking. Run `sendTestEmail()` to preview the email layout with fake data.

### 4. Start the watcher

Run `setupTrigger()` once. This sets up a recurring trigger that calls `checkForNewResults()` every `CHECK_INTERVAL_MIN` minutes automatically.

To stop it, run `removeTrigger()`.

## Email output

Each notification email includes a table with:

| Column | Description |
|---|---|
| Class | Section name |
| Assessment | Task/exam name |
| Score | Raw score (e.g. `39 / 50`) |
| Percentage | Color-coded: green ≥90%, orange ≥75%, red <75% |
| Rank | Your rank in the section (e.g. `#7 of 40`) |
| Link | Direct link to the activity page |

## Functions

| Function | Description |
|---|---|
| `checkForNewResults()` | Main entry point — runs automatically via trigger |
| `setupTrigger()` | Registers the time-based trigger |
| `removeTrigger()` | Removes all triggers |
| `debugFull()` | End-to-end test — logs sections, tasks, scores, and rankings |
| `debugRanking()` | Probes the ranking endpoint against a known task |
| `sendTestEmail()` | Sends a preview email with fake data |

## Requirements

- A Google account with Gmail access
- A GradeChum student account
