use ocrs::{ImageSource, OcrEngine, OcrEngineParams, TextItem};
use rten::Model;

use crate::{
    db::Library,
    error::{BeverError, Result},
    picture::decode_upright,
    resources::OCR_MAX_BYTES,
};

/// Recognises queued images until the queue is empty or `keep_going` returns
/// false, which is checked before each image. `progress` receives the number
/// of images still waiting. Returns how many images were processed.
///
/// A missing or undecodable image is marked as failed so that it is not
/// retried forever; the attachment itself is never changed.
pub fn process_ocr_queue(
    library: &Library,
    engine: &mut LocalOcr,
    mut keep_going: impl FnMut() -> bool,
    mut progress: impl FnMut(u64),
) -> Result<u64> {
    let mut processed = 0;
    while keep_going() {
        let Some(sha256) = library.next_ocr_job()? else {
            break;
        };
        match library
            .read_blob(&sha256)
            .and_then(|bytes| engine.recognize(&bytes))
        {
            Ok(found) => library.finish_ocr(&sha256, found.as_ref(), true)?,
            Err(_) => library.finish_ocr(&sha256, None, false)?,
        }
        processed += 1;
        progress(library.ocr_pending()?);
    }
    Ok(processed)
}

/// The text found in a picture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recognized {
    /// The words in reading order, with a space between them.
    pub text: String,
    /// The words with their places in the picture, as a `recoIndex`
    /// document: the form Evernote keeps recognised text in.
    pub xml: String,
}

/// A word and its rectangle in the picture's pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacedWord {
    pub text: String,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// The `recoIndex` document for `words` found in a picture of the given
/// size, whose bytes have the MD5 `object_id`.
pub fn recognition_xml(object_id: &str, width: u32, height: u32, words: &[PlacedWord]) -> String {
    let mut xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE recoIndex PUBLIC \"SYSTEM\" \"http://xml.evernote.com/pub/recoIndex.dtd\"><recoIndex docType=\"printed\" objType=\"image\" objID=\"{object_id}\" engineVersion=\"ocrs-0.13\" recoType=\"client\" lang=\"en\" objWidth=\"{width}\" objHeight=\"{height}\">"
    );
    for word in words {
        let text = word
            .text
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        xml.push_str(&format!(
            "<item x=\"{}\" y=\"{}\" w=\"{}\" h=\"{}\"><t w=\"80\">{text}</t></item>",
            word.x, word.y, word.width, word.height
        ));
    }
    xml.push_str("</recoIndex>");
    xml
}

/// On-device OCR using bundled, openly licensed models. No network access is used.
pub struct LocalOcr {
    engine: OcrEngine,
}

impl LocalOcr {
    pub fn new() -> Result<Self> {
        let detection_model = Model::load(include_bytes!("../models/text-detection.onnx").to_vec())
            .map_err(|error| BeverError::Invalid(format!("load OCR detection model: {error}")))?;
        let recognition_model = Model::load(
            include_bytes!("../models/text-recognition.onnx").to_vec(),
        )
        .map_err(|error| BeverError::Invalid(format!("load OCR recognition model: {error}")))?;
        let engine = OcrEngine::new(OcrEngineParams {
            detection_model: Some(detection_model),
            recognition_model: Some(recognition_model),
            ..Default::default()
        })
        .map_err(|error| BeverError::Invalid(format!("initialize OCR: {error}")))?;
        Ok(Self { engine })
    }

    /// The text in a picture and where each word stands, or `None` when it
    /// shows no text.
    pub fn recognize(&mut self, bytes: &[u8]) -> Result<Option<Recognized>> {
        // Avoid spending minutes on oversized images; the original bytes are
        // always retained untouched.
        if bytes.len() as u64 > OCR_MAX_BYTES {
            return Ok(None);
        }
        let decoded = decode_upright(bytes)?;
        let (width, height) = (decoded.width(), decoded.height());
        let image = decoded.thumbnail(2200, 2200).into_rgb8();
        // Words are found in the smaller picture; their places are given in
        // the picture's own pixels.
        let scale_x = f64::from(width) / f64::from(image.width().max(1));
        let scale_y = f64::from(height) / f64::from(image.height().max(1));
        let failed =
            |error: anyhow::Error| BeverError::Invalid(format!("recognize image text: {error}"));
        let source = ImageSource::from_bytes(image.as_raw(), image.dimensions())
            .map_err(|error| BeverError::Invalid(format!("prepare OCR image: {error}")))?;
        let input = self.engine.prepare_input(source).map_err(failed)?;
        let found = self.engine.detect_words(&input).map_err(failed)?;
        let lines = self.engine.find_text_lines(&input, &found);
        let mut words = Vec::new();
        for line in self
            .engine
            .recognize_text(&input, &lines)
            .map_err(failed)?
            .into_iter()
            .flatten()
        {
            for word in line.words() {
                let text = word.to_string();
                if text.trim().is_empty() {
                    continue;
                }
                let area = word.bounding_rect();
                let place = |value: i32, scale: f64, limit: u32| {
                    ((f64::from(value.max(0)) * scale).round() as u32).min(limit)
                };
                let x = place(area.left(), scale_x, width);
                let y = place(area.top(), scale_y, height);
                words.push(PlacedWord {
                    text,
                    x,
                    y,
                    width: place(area.width(), scale_x, width - x).max(1),
                    height: place(area.height(), scale_y, height - y).max(1),
                });
            }
        }
        if words.is_empty() {
            return Ok(None);
        }
        let text = words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let xml = recognition_xml(&format!("{:x}", md5::compute(bytes)), width, height, &words);
        Ok(Some(Recognized { text, xml }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::enml::recognition_text;

    #[test]
    fn recognised_words_are_written_as_evernote_writes_them() {
        let words = [
            PlacedWord {
                text: "A&B".into(),
                x: 10,
                y: 20,
                width: 30,
                height: 12,
            },
            PlacedWord {
                text: "<total>".into(),
                x: 50,
                y: 20,
                width: 60,
                height: 12,
            },
        ];
        let xml = recognition_xml("0123abcd", 640, 480, &words);
        assert!(xml.contains("objID=\"0123abcd\""));
        assert!(xml.contains("objWidth=\"640\" objHeight=\"480\""));
        assert!(xml
            .contains("<item x=\"10\" y=\"20\" w=\"30\" h=\"12\"><t w=\"80\">A&amp;B</t></item>"));
        assert!(xml.contains("<t w=\"80\">&lt;total&gt;</t>"));
        // It is read back as the words alone, which is what a search looks in.
        assert_eq!(recognition_text(&xml), "A&B <total>");
    }
}
