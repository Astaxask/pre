use image::{Rgba, RgbaImage};
use std::path::Path;

const SIZE: u32 = 22;

/// Compute anti-aliased alpha for a pixel at distance `dist` from an edge at `edge`.
/// Returns 0.0..=1.0. Pixels fully inside the edge get 1.0, outside get 0.0,
/// and the boundary pixel row is linearly interpolated.
fn aa(dist_from_edge: f64) -> f64 {
    (dist_from_edge + 0.5).clamp(0.0, 1.0)
}

/// tray-idle.png: filled circle, center (11,11), radius 4
fn generate_idle() -> RgbaImage {
    let mut img = RgbaImage::new(SIZE, SIZE);
    let cx = 11.0_f64;
    let cy = 11.0_f64;
    let r = 4.0_f64;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f64 + 0.5 - cx;
            let dy = y as f64 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            let alpha = aa(r - dist);
            if alpha > 0.0 {
                img.put_pixel(x, y, Rgba([255, 255, 255, (alpha * 255.0) as u8]));
            }
        }
    }
    img
}

/// tray-alert.png: ring (circle stroke only), center (11,11), radius 4, stroke 1.5
fn generate_alert() -> RgbaImage {
    let mut img = RgbaImage::new(SIZE, SIZE);
    let cx = 11.0_f64;
    let cy = 11.0_f64;
    let r = 4.0_f64;
    let stroke = 1.5_f64;
    let outer = r + stroke / 2.0;
    let inner = r - stroke / 2.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f64 + 0.5 - cx;
            let dy = y as f64 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            let a_outer = aa(outer - dist);
            let a_inner = aa(dist - inner);
            let alpha = a_outer * a_inner;
            if alpha > 0.0 {
                img.put_pixel(x, y, Rgba([255, 255, 255, (alpha * 255.0) as u8]));
            }
        }
    }
    // Add a small filled dot in the center (2px radius) to distinguish from attention
    let dot_r = 1.5_f64;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f64 + 0.5 - cx;
            let dy = y as f64 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            let alpha = aa(dot_r - dist);
            if alpha > 0.0 {
                // Blend with existing pixel
                let existing = img.get_pixel(x, y);
                let new_a = ((alpha * 255.0) as u8).max(existing[3]);
                img.put_pixel(x, y, Rgba([255, 255, 255, new_a]));
            }
        }
    }
    img
}

/// tray-attention.png: ring, center (11,11), radius 3, stroke 1.5
fn generate_attention() -> RgbaImage {
    let mut img = RgbaImage::new(SIZE, SIZE);
    let cx = 11.0_f64;
    let cy = 11.0_f64;
    let r = 3.0_f64;
    let stroke = 1.5_f64;
    let outer = r + stroke / 2.0;
    let inner = r - stroke / 2.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f64 + 0.5 - cx;
            let dy = y as f64 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            let a_outer = aa(outer - dist);
            let a_inner = aa(dist - inner);
            let alpha = a_outer * a_inner;
            if alpha > 0.0 {
                img.put_pixel(x, y, Rgba([255, 255, 255, (alpha * 255.0) as u8]));
            }
        }
    }
    img
}

/// tray-offline.png: horizontal line, y=11, x=7 to x=15, stroke 1.5
fn generate_offline() -> RgbaImage {
    let mut img = RgbaImage::new(SIZE, SIZE);
    let y_center = 11.0_f64;
    let x_start = 7.0_f64;
    let x_end = 15.0_f64;
    let half_stroke = 0.75_f64;

    for y in 0..SIZE {
        for x in 0..SIZE {
            let px = x as f64 + 0.5;
            let py = y as f64 + 0.5;
            let dy = (py - y_center).abs();
            let a_y = aa(half_stroke - dy);
            let a_xl = aa(px - x_start);
            let a_xr = aa(x_end - px);
            let alpha = a_y * a_xl * a_xr;
            if alpha > 0.0 {
                img.put_pixel(x, y, Rgba([255, 255, 255, (alpha * 255.0) as u8]));
            }
        }
    }
    img
}

fn main() {
    // Generate tray icon PNGs if they don't already exist
    let icons_dir = Path::new("icons");
    let icons: &[(&str, fn() -> RgbaImage)] = &[
        ("tray-idle.png", generate_idle),
        ("tray-alert.png", generate_alert),
        ("tray-attention.png", generate_attention),
        ("tray-offline.png", generate_offline),
    ];

    for (name, generator) in icons {
        let path = icons_dir.join(name);
        // Only generate if the file doesn't exist yet — avoids triggering
        // Tauri's file watcher which would cause an infinite rebuild loop
        if !path.exists() {
            let img = generator();
            img.save(&path).unwrap_or_else(|e| {
                panic!("Failed to save {}: {}", path.display(), e);
            });
        }
        println!("cargo:rerun-if-changed={}", path.display());
    }

    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build();
}
