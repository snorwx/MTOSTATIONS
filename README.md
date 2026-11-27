# MTO stations

Collects the latest reading from every Ontario Ministry of Transportation road weather station, as published by
Environment and Climate Change Canada (`dd.weather.gc.ca`, SWOB-ML partner data), into one JSON file.

A scheduled job runs `scripts/build-mto.mjs` every 10 minutes and publishes the result as `mto.json` on the `data` branch:

    https://raw.githubusercontent.com/snorwx/MTOSTATIONS/data/mto.json

Data source: Environment and Climate Change Canada / Ontario Ministry of Transportation.
