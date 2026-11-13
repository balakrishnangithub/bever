//! Reading pictures: upright, as they are shown, and made small for lists.
use std::io::Cursor;

use image::{DynamicImage, ImageDecoder, ImageReader, Rgb, RgbImage};

use crate::error::{BeverError, Result};

/// Decodes a picture the way it is shown: a photograph that says it was
/// taken with the camera turned is turned upright.
pub fn decode_upright(bytes: &[u8]) -> Result<DynamicImage> {
    let invalid = |error: image::ImageError| BeverError::Invalid(format!("decode image: {error}"));
    let mut decoder = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| BeverError::Invalid(format!("decode image: {error}")))?
        .into_decoder()
        .map_err(invalid)?;
    let orientation = decoder.orientation().map_err(invalid)?;
    let mut picture = DynamicImage::from_decoder(decoder).map_err(invalid)?;
    picture.apply_orientation(orientation);
    Ok(picture)
}

/// A small JPEG of a picture, at most `side` pixels wide and high, for the
/// list of notes. What is transparent in the picture is white in it.
pub fn thumbnail(bytes: &[u8], side: u32) -> Result<Vec<u8>> {
    let picture = decode_upright(bytes)?;
    // A picture that is small already is not made larger.
    let small = if picture.width() > side || picture.height() > side {
        picture.thumbnail(side, side)
    } else {
        picture
    }
    .into_rgba8();
    let mut flat = RgbImage::new(small.width(), small.height());
    for (target, source) in flat.pixels_mut().zip(small.pixels()) {
        let alpha = u32::from(source[3]);
        let over = |value: u8| ((u32::from(value) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        *target = Rgb([over(source[0]), over(source[1]), over(source[2])]);
    }
    let mut encoded = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 82)
        .encode_image(&flat)
        .map_err(|error| BeverError::Invalid(format!("encode thumbnail: {error}")))?;
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use image::{ImageFormat, Rgba, RgbaImage};

    use super::*;

    fn png(picture: &RgbaImage) -> Vec<u8> {
        let mut bytes = Vec::new();
        picture
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        bytes
    }

    #[test]
    fn a_thumbnail_keeps_the_shape_and_fits_the_side() {
        let picture = RgbaImage::from_pixel(400, 100, Rgba([200, 30, 30, 255]));
        let small = image::load_from_memory(&thumbnail(&png(&picture), 120).unwrap()).unwrap();
        assert_eq!((small.width(), small.height()), (120, 30));
        let pixel = small.to_rgb8().get_pixel(60, 15).0;
        assert!(
            pixel[0] > 180 && pixel[1] < 60 && pixel[2] < 60,
            "{pixel:?}"
        );
    }

    #[test]
    fn what_is_transparent_becomes_white() {
        let picture = RgbaImage::from_pixel(40, 40, Rgba([0, 0, 0, 0]));
        let small = image::load_from_memory(&thumbnail(&png(&picture), 120).unwrap()).unwrap();
        // A small picture is not made larger.
        assert_eq!((small.width(), small.height()), (40, 40));
        assert!(small
            .to_rgb8()
            .get_pixel(20, 20)
            .0
            .iter()
            .all(|value| *value > 245));
    }

    #[test]
    fn a_single_pixel_has_a_thumbnail() {
        let pixel = RgbaImage::from_pixel(1, 1, Rgba([10, 20, 30, 255]));
        let small = image::load_from_memory(&thumbnail(&png(&pixel), 240).unwrap()).unwrap();
        assert_eq!((small.width(), small.height()), (1, 1));
    }

    #[test]
    fn what_is_not_a_picture_is_refused() {
        assert!(thumbnail(b"not a picture", 120).is_err());
        assert!(decode_upright(&[]).is_err());
    }
}
