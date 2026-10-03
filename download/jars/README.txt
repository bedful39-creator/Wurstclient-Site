Custom Wurst builds
===================

Drop your custom build files in this folder using the official file names.

    node _scripts/generate-custom-jars.js

rescans this folder and writes _data/custom_jars.yml, which the download
buttons on the update pages read. The deploy workflow runs this step
automatically before every build, and the local server (server.js) rescans on
startup, so committing the jars is enough.

Per-download files
------------------

Only the 5 most downloaded builds have their own file here, named exactly as
that download expects. They hold real builds:

    Wurst-Client-v6.16-MC1.12.jar
    Wurst-Client-v6.25-MC1.12.jar
    Wurst-Client-v7.15.2-MC1.16.5.jar
    Wurst-Client-v7.35.1-MC1.20.1.jar
    Wurst-Client-v6.11.1-MC1.12.jar

Only those 5 download buttons serve their own file. There are no .zip files
and no -sources.jar files, so the "Wurst installer for Windows" (.zip) buttons
use the catch-all too and the sources links keep going to GitHub.

Catch-all
---------

    Wurst-Client-V8.1-MC.jar

is the fallback: every download button without a matching file above points to
it, which is the majority of them. It is currently a stub, not a working
build. Replace it with a real build before deploying, or those buttons will
serve the stub to visitors. Keep the exact file name - the scan skips this
file by name and serves it through the fallback entry instead.

Any file that still contains WURST-CUSTOM-JAR-PLACEHOLDER is ignored by the
scan, so a placeholder never goes live; overwriting it with real build bytes
switches that one button over on the next scan.

Placeholder generation
----------------------

    node _scripts/create-placeholder-jars.js
    node _scripts/create-placeholder-jars.js --dry-run

recreates the 5 per-download placeholders (existing files are never
overwritten, so real builds are safe). Use --all instead of nothing to create
a placeholder for every single download rather than just the top 5.

Naming
------

Keep the official file names so each download can be matched to its version.
Only the file name matters, so no subfolders are used.
