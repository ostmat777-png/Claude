// Exit code 0 when this Node.js is new enough to install and start Kaplya.
// Used by run.bat. Written in old-style JavaScript on purpose: it has to run,
// and say "too old", on very old versions too.
var major = parseInt(String(process.versions.node).split('.')[0], 10);
process.exit(major >= 20 ? 0 : 1);
