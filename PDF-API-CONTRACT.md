# Invoice/PDF code patterns — DO NOT VIOLATE

When editing `src-tauri/src/invoice.rs` or any code that touches PDF generation
or image handling, use ONLY these API patterns. Any other variant will fail to
compile because of the printpdf 0.7 + image crate version pinning in this project.

## ? CORRECT — use these exactly

```rust
// Read file bytes
let bytes = std::fs::read(logo_path).unwrap_or_default();

// Decode image bytes to DynamicImage
let dyn_img = printpdf::image_crate::load_from_memory(&bytes)?;

// Build a printpdf Image from raw RGB bytes (preferred — works in all cases)
let rgb = dyn_img.to_rgb8();
let (w, h) = rgb.dimensions();
let raw = rgb.into_raw();
let xobj = printpdf::ImageXObject {
    width: printpdf::Px(w as usize),
    height: printpdf::Px(h as usize),
    color_space: printpdf::ColorSpace::Rgb,
    bits_per_component: printpdf::ColorBits::Bit8,
    image_data: raw,
    interpolate: true,
    image_filter: None,
    clipping_bbox: None,
    smask: None,
};
let pimg = printpdf::Image::from(xobj);

// Save PDF document to bytes
use std::io::BufWriter;
let mut writer = BufWriter::new(Vec::new());
doc.save(&mut writer)?;
let pdf_bytes = writer.into_inner()
    .map_err(|e| anyhow::anyhow!("BufWriter flush: {}", e))?;
```

## ? WRONG — these will fail to compile

```rust
// All of these are NOT in our `image` crate version (0.24, pinned by printpdf):
image::open(path)                 // ? doesn't exist at top level
image::io::Reader::open(path)     // ? submodule not exposed
image::ImageReader::open(path)    // ? wrong path
image::load_from_memory(...)      // ? not at top level

// All of these are NOT valid printpdf::Image constructors:
Image::from_reader(...)           // ? doesn't exist
Image::try_from(&[u8])            // ? wrong signature

// This will not work:
doc.save(&mut Vec::<u8>::new())   // ? needs &mut BufWriter
```

## Cargo.toml feature flags that MUST stay enabled

```toml
printpdf = { version = "0.7", features = ["embedded_images"] }
```

Without `embedded_images`, the `printpdf::image_crate` re-export is gated out
and decoding won't work. Do not remove this feature flag.

## When in doubt

Read the existing working code in `invoice.rs`. The current implementation is
correct. If you find yourself writing one of the WRONG patterns above, STOP —
copy from the existing working code instead.
