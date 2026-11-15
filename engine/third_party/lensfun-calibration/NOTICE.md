# Lens calibration provenance

The additional `resources/lens_profiles.json` measurements are baked without
changing their coefficients from Lensfun **v0.3.4**, commit
`101c745e847a5de4a1e569a94368ce2027198598`:
https://github.com/lensfun/lensfun/tree/v0.3.4/data/db

Copyright the Lensfun database contributors. Database licence: **CC BY-SA 3.0**,
included as `CC-BY-SA-3.0.txt`. The original XML, calibration tools and complete
source are preserved in `lensfun-v0.3.4-source.tar.gz`. Re-bake with
`engine/tools/bake_lens_database.py` and the pinned checkout. This is separate
from SpektraLab's measured film and paper resources, which are unchanged.

The coordinate normalization, distortion/TCA polynomials and coefficient
interpolation in `host/lens_correction.cpp` follow Lensfun's `modifier.cpp`,
`mod-coord.cpp`, `mod-subpix.cpp`, `mod-color.cpp`, `lens.cpp` and `auxfun.cpp`.
Original library authors include Andrew Zabolotny, Torsten Bronger and the
Lensfun contributors. The library is LGPL-3.0; the adapted code is combined
under this application's GPL-3.0-or-later, as allowed by LGPL-3.0 section 2b.
The original LGPL text is retained here. The Windows runtime does not require
Python, XML parsing, GLib or a Lensfun shared library.

Windows RAW decode uses LibRaw and this measured lens database. It does not
claim to reproduce Apple's private Core Image decoder or lens calibrations.
Unknown/ambiguous lens matches are refused. Missing individual calibrations
are not fabricated; the available measured distortion, TCA and vignetting
components are applied. Calibration selection must be shown by profile name.
