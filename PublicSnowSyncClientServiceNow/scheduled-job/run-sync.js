/*
 * Scheduled Script Execution: "e-automate sync"
 * System Definition > Scheduled Jobs > New > "Automatically run a script of your choosing".
 * Run: Periodically, every 5–15 minutes. Run as: a dedicated integration user (see the README).
 *
 * PRODUCTION NOTE: if a run takes longer than the interval, the next one can start while it is
 * still going and create duplicates. Keep the interval comfortably longer than a run, or add a
 * simple lock (e.g. a "running since" system property checked at the start).
 */
new EautomateSync().run();
