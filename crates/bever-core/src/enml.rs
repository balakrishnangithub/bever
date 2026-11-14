//! Conversion between Evernote's ENML and the HTML the editor works with.
//!
//! Import is deliberately light: it only removes the ENML wrapper and makes
//! Evernote-specific elements parseable as HTML, so an unedited note still
//! corresponds to its source. Export is strict: the editor's HTML is
//! re-serialized as well-formed XML limited to what the ENML DTD allows.
use std::fmt::Write as _;

use regex::{Captures, Regex};
use scraper::{ElementRef, Html, Node};

use crate::enex::is_xml_char;

/// Elements an HTML parser never treats as containers. Any other element
/// written as `<x/>` in ENML must be expanded to `<x></x>`, or an HTML parser
/// would swallow the content that follows it.
const HTML_VOID: [&str; 14] = [
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

/// Elements permitted by the ENML 2 DTD, plus Evernote's own.
const ENML_ELEMENTS: [&str; 66] = [
    "a",
    "abbr",
    "acronym",
    "address",
    "area",
    "b",
    "bdo",
    "big",
    "blockquote",
    "br",
    "caption",
    "center",
    "cite",
    "code",
    "col",
    "colgroup",
    "dd",
    "del",
    "dfn",
    "div",
    "dl",
    "dt",
    "em",
    "font",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "ins",
    "kbd",
    "li",
    "map",
    "ol",
    "p",
    "pre",
    "q",
    "s",
    "samp",
    "small",
    "span",
    "strike",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "tt",
    "u",
    "ul",
    "var",
    "xmp",
    "en-media",
    "en-todo",
    "en-crypt",
    "en-note",
];

/// Written as `<x/>` in ENML.
const ENML_EMPTY: [&str; 7] = ["area", "br", "col", "hr", "img", "en-media", "en-todo"];

/// Removed together with everything inside them.
const DROPPED: [&str; 22] = [
    "script", "style", "iframe", "object", "embed", "applet", "form", "input", "button", "select",
    "textarea", "label", "noscript", "head", "meta", "link", "svg", "math", "canvas", "video",
    "audio", "template",
];

/// Sectioning elements ENML lacks; a `div` keeps their block layout.
const BLOCK_FALLBACK: [&str; 10] = [
    "section",
    "article",
    "header",
    "footer",
    "nav",
    "aside",
    "main",
    "figure",
    "figcaption",
    "details",
];

pub fn enml_to_html(enml: &str) -> String {
    let without_declaration = strip_prefix(enml);
    let mut html = without_declaration
        .replace("<en-note>", "")
        .replace("</en-note>", "");
    html = replace_enote_open_tag(&html);
    html = expand_self_closed_elements(&html);
    html = mark_checklists(&html);
    html.trim().to_owned()
}

fn strip_prefix(enml: &str) -> String {
    let declaration = Regex::new(r"(?s)<\?xml.*?\?>").expect("valid regex");
    let doctype = Regex::new(r"(?s)<!DOCTYPE[^>]*>").expect("valid regex");
    let value = declaration.replace_all(enml, "");
    doctype.replace_all(&value, "").into_owned()
}

fn replace_enote_open_tag(html: &str) -> String {
    Regex::new(r"<en-note(?:\s[^>]*)?/?>")
        .expect("valid regex")
        .replace_all(html, "")
        .into_owned()
}

fn expand_self_closed_elements(html: &str) -> String {
    Regex::new(r#"<([A-Za-z][A-Za-z0-9-]*)((?:\s+[^<>"']*(?:"[^"]*"|'[^']*')?)*?)\s*/>"#)
        .expect("valid regex")
        .replace_all(html, |captures: &Captures| {
            let name = &captures[1];
            if HTML_VOID.contains(&name.to_ascii_lowercase().as_str()) {
                captures[0].to_owned()
            } else {
                format!("<{name}{}></{name}>", &captures[2])
            }
        })
        .into_owned()
}

/// Marks Evernote checklists so the editor reads them as task lists.
///
/// Evernote 10 and later write `<ul style="--en-todo:true;">` with
/// `--en-checked:true` on completed items; some other tools put both
/// properties on each `<li>`. Either shape is recognised.
fn mark_checklists(html: &str) -> String {
    if !html.contains("--en-todo") {
        return html.to_owned();
    }
    let tag = Regex::new(r"(?i)<(/?)(ul|ol|li)\b([^>]*)>").expect("valid regex");
    let todo = Regex::new(r"--en-todo\s*:\s*true").expect("valid regex");
    let checked = Regex::new(r"--en-checked\s*:\s*true").expect("valid regex");
    let tags: Vec<Captures> = tag.captures_iter(html).collect();

    // First pass: decide which lists are checklists.
    let mut is_checklist = vec![false; tags.len()];
    let mut open_lists: Vec<usize> = Vec::new();
    for (index, captures) in tags.iter().enumerate() {
        let closing = !captures[1].is_empty();
        let name = captures[2].to_ascii_lowercase();
        let attributes = &captures[3];
        match (name.as_str(), closing) {
            ("li", false) => {
                if todo.is_match(attributes) {
                    if let Some(&list) = open_lists.last() {
                        is_checklist[list] = true;
                    }
                }
            }
            ("li", true) => {}
            (_, false) => {
                is_checklist[index] = name == "ul" && todo.is_match(attributes);
                open_lists.push(index);
            }
            (_, true) => {
                open_lists.pop();
            }
        }
    }

    // Second pass: rewrite the opening tags of checklists and their items.
    let mut output = String::with_capacity(html.len() + 64);
    let mut cursor = 0;
    open_lists.clear();
    for (index, captures) in tags.iter().enumerate() {
        let whole = captures.get(0).expect("match");
        output.push_str(&html[cursor..whole.start()]);
        cursor = whole.end();
        let closing = !captures[1].is_empty();
        let name = &captures[2];
        let attributes = &captures[3];
        let lowered = name.to_ascii_lowercase();
        let already_marked = attributes.contains("data-type=");
        match (lowered.as_str(), closing) {
            ("li", false)
                if !already_marked && open_lists.last().is_some_and(|&list| is_checklist[list]) =>
            {
                let _ = write!(
                    output,
                    "<{name} data-type=\"taskItem\" data-checked=\"{}\"{attributes}>",
                    checked.is_match(attributes)
                );
            }
            ("ul" | "ol", false) => {
                open_lists.push(index);
                if is_checklist[index] && !already_marked {
                    let _ = write!(output, "<{name} data-type=\"taskList\"{attributes}>");
                } else {
                    output.push_str(whole.as_str());
                }
            }
            ("ul" | "ol", true) => {
                open_lists.pop();
                output.push_str(whole.as_str());
            }
            _ => output.push_str(whole.as_str()),
        }
    }
    output.push_str(&html[cursor..]);
    output
}

/// Serializes editor HTML as an ENML document.
pub fn html_to_enml(html: &str) -> String {
    let document = Html::parse_fragment(html);
    let mut body = String::with_capacity(html.len() + 128);
    write_children(document.root_element(), &mut body);
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n<!DOCTYPE en-note SYSTEM \"http://xml.evernote.com/pub/enml2.dtd\"><en-note>{body}</en-note>"
    )
}

fn write_children(element: ElementRef<'_>, output: &mut String) {
    for child in element.children() {
        match child.value() {
            Node::Text(text) => push_xml_text(output, text),
            Node::Element(_) => {
                if let Some(child) = ElementRef::wrap(child) {
                    write_element(child, output);
                }
            }
            _ => {}
        }
    }
}

fn write_element(element: ElementRef<'_>, output: &mut String) {
    let value = element.value();
    let name = value.name().to_ascii_lowercase();
    if DROPPED.contains(&name.as_str()) {
        return;
    }
    let data_type = value.attr("data-type");
    let mut extra_style = String::new();
    let enml_name = match name.as_str() {
        // The editor's highlight mark is a styled span in ENML.
        "mark" => {
            // Evernote marks its highlights this way; the editor reads the
            // marker back, so a highlight survives export and import.
            extra_style.push_str("--en-highlight:yellow;");
            if value
                .attr("style")
                .is_none_or(|style| !style.contains("background"))
            {
                extra_style.push_str("background-color: #fff3a3;");
            }
            "span"
        }
        "ul" if data_type == Some("taskList") => {
            extra_style.push_str("--en-todo:true;");
            "ul"
        }
        "li" if data_type == Some("taskItem") => {
            let checked = value.attr("data-checked") == Some("true");
            let _ = write!(extra_style, "--en-checked:{checked};");
            "li"
        }
        other if ENML_ELEMENTS.contains(&other) && other != "en-note" => other,
        other if BLOCK_FALLBACK.contains(&other) => "div",
        // Anything else contributes its content only.
        _ => {
            write_children(element, output);
            return;
        }
    };
    // The editor's empty line is an empty paragraph, which other
    // applications show as no line at all. Evernote's own form is written.
    if matches!(enml_name, "p" | "div") && element.children().next().is_none() {
        output.push_str("<div><br/></div>");
        return;
    }

    output.push('<');
    output.push_str(enml_name);
    let mut style = extra_style;
    for (attribute, attribute_value) in value.attrs() {
        let attribute = attribute.to_ascii_lowercase();
        if attribute == "style" {
            style.push_str(attribute_value);
        } else if attribute == "colwidth" {
            // The editor's column width; ENML only understands CSS.
            if let Some(width) = attribute_value
                .split(',')
                .next()
                .and_then(|first| first.trim().parse::<u32>().ok())
            {
                let _ = write!(style, "width: {width}px;");
            }
        } else if is_enml_attribute(&attribute) {
            output.push(' ');
            output.push_str(&attribute);
            output.push_str("=\"");
            push_xml_attribute(output, attribute_value);
            output.push('"');
        }
    }
    if !style.is_empty() {
        output.push_str(" style=\"");
        push_xml_attribute(output, &style);
        output.push('"');
    }
    if ENML_EMPTY.contains(&enml_name) {
        output.push_str("/>");
        return;
    }
    output.push('>');
    write_children(element, output);
    output.push_str("</");
    output.push_str(enml_name);
    output.push('>');
}

/// ENML forbids scripting hooks and identity attributes; everything the
/// editor adds for its own use (`data-*`, `class`) goes too.
fn is_enml_attribute(name: &str) -> bool {
    let valid_name = name
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'));
    valid_name
        && !name.starts_with("on")
        && !name.starts_with("data-")
        && !matches!(
            name,
            "id" | "class"
                | "accesskey"
                | "data"
                | "dynsrc"
                | "tabindex"
                | "contenteditable"
                | "draggable"
                | "spellcheck"
        )
}

fn push_xml_text(output: &mut String, text: &str) {
    for character in text.chars().filter(|&c| is_xml_char(c)) {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            other => output.push(other),
        }
    }
}

fn push_xml_attribute(output: &mut String, text: &str) {
    for character in text.chars().filter(|&c| is_xml_char(c)) {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '"' => output.push_str("&quot;"),
            other => output.push(other),
        }
    }
}

pub fn plain_text(html: &str) -> String {
    let document = Html::parse_fragment(html);
    let text = document.root_element().text().collect::<Vec<_>>().join(" ");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn recognition_text(recognition_xml: &str) -> String {
    plain_text(recognition_xml)
}

/// Lower-cased text with runs of whitespace collapsed, for matching a link's
/// text against note titles.
pub fn normalized_title(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Points Evernote note links at local notes.
///
/// `resolve` receives the linked note's GUID, when the address contains one,
/// and the link's visible text, and returns the local note id. Evernote 10
/// exports carry no GUIDs, so the text, which Evernote sets to the target's
/// title when a link is created, is usually the only handle available.
/// Returns the rewritten HTML and the number of links changed.
pub fn rewrite_internal_links(
    html: &str,
    resolve: &dyn Fn(Option<&str>, &str) -> Option<String>,
) -> (String, usize) {
    let anchor = Regex::new(r#"(?is)(<a\b[^>]*?\bhref\s*=\s*)("[^"]*"|'[^']*')([^>]*>)(.*?)</a>"#)
        .expect("valid regex");
    let guid = Regex::new(
        r"(?i)^(?:evernote:///view/[^/]+/[^/]+/|https?://(?:www\.)?evernote\.com/shard/[^/]+/(?:nl|sh)/(?:[^/]+/)?)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    )
    .expect("valid regex");
    let tags = Regex::new(r"(?s)<[^>]*>").expect("valid regex");
    let mut changed = 0;
    let rewritten = anchor.replace_all(html, |captures: &Captures| {
        let quoted = &captures[2];
        let href = html_escape::decode_html_entities(&quoted[1..quoted.len() - 1]);
        if !is_evernote_note_link(&href) {
            return captures[0].to_owned();
        }
        let target = guid.captures(&href).map(|found| found[1].to_lowercase());
        let text =
            html_escape::decode_html_entities(&tags.replace_all(&captures[4], " ")).into_owned();
        match resolve(target.as_deref(), &normalized_title(&text)) {
            Some(id) => {
                changed += 1;
                format!(
                    "{}\"bever://note/{id}\"{}{}</a>",
                    &captures[1], &captures[3], &captures[4]
                )
            }
            None => captures[0].to_owned(),
        }
    });
    (rewritten.into_owned(), changed)
}

/// `html` with its links to other notes leading nowhere, whether they are
/// Evernote's links or were pointed at notes of this library. Two forms of a
/// note that are the same after this differ only in where such links lead.
pub fn without_note_link_targets(html: &str) -> String {
    let anchor =
        Regex::new(r#"(?is)(<a\b[^>]*?\bhref\s*=\s*)("[^"]*"|'[^']*')"#).expect("valid regex");
    anchor
        .replace_all(html, |captures: &Captures| {
            let quoted = &captures[2];
            let href = html_escape::decode_html_entities(&quoted[1..quoted.len() - 1]);
            if is_evernote_note_link(&href) || href.trim().starts_with("bever://note/") {
                format!("{}\"\"", &captures[1])
            } else {
                captures[0].to_owned()
            }
        })
        .into_owned()
}

/// Whether an address refers to another Evernote note.
pub fn is_evernote_note_link(href: &str) -> bool {
    let lowered = href.trim().to_ascii_lowercase();
    lowered.starts_with("evernote:///view/")
        || lowered.starts_with("https://www.evernote.com/shard/")
        || lowered.starts_with("https://evernote.com/shard/")
        || lowered.starts_with("http://www.evernote.com/shard/")
        || lowered.starts_with("https://www.evernote.com/l/")
}

pub fn escape_cdata(value: &str) -> String {
    value.replace("]]>", "]]]]><![CDATA[>")
}

#[cfg(test)]
mod tests {
    use quick_xml::{events::Event, Reader};

    use super::*;

    /// Parses ENML as XML and returns the element names it contains.
    fn enml_elements(enml: &str) -> Vec<String> {
        let mut reader = Reader::from_str(enml);
        reader.config_mut().check_end_names = true;
        let mut names = Vec::new();
        loop {
            match reader.read_event().expect("ENML must be well-formed XML") {
                Event::Start(element) | Event::Empty(element) => {
                    names.push(element.name().as_ref().to_owned());
                }
                Event::Eof => break,
                _ => {}
            }
        }
        names
    }

    #[test]
    fn preserves_evernote_elements_for_the_editor() {
        let enml = r#"<?xml version="1.0"?><!DOCTYPE en-note SYSTEM "x"><en-note><div>Hello <en-todo checked="true"/><en-media hash="abc" type="image/png"/></div></en-note>"#;
        let html = enml_to_html(enml);
        assert!(html.contains("<en-todo checked=\"true\"></en-todo>"));
        assert!(html.contains("<en-media hash=\"abc\" type=\"image/png\"></en-media>"));
        assert_eq!(plain_text(&html), "Hello");
        assert!(html_to_enml(&html).contains("<en-todo checked=\"true\"/>"));
    }

    #[test]
    fn self_closed_containers_are_expanded_but_void_elements_are_kept() {
        let html = enml_to_html(
            r#"<en-note><div/><span style="color: red"/><td/><br/><hr /><img src="a.png"/><div>after</div></en-note>"#,
        );
        assert_eq!(
            html,
            r#"<div></div><span style="color: red"></span><td></td><br/><hr /><img src="a.png"/><div>after</div>"#
        );
    }

    #[test]
    fn evernote_10_checklists_become_task_lists() {
        let html = enml_to_html(
            r#"<en-note><ul style="--en-todo:true;"><li><div>Open</div></li><li style="--en-checked:true;"><div>Done</div></li><li style="--en-checked:false;"><div>Later</div></li></ul><ul><li>Plain</li></ul></en-note>"#,
        );
        assert_eq!(
            html,
            r#"<ul data-type="taskList" style="--en-todo:true;"><li data-type="taskItem" data-checked="false"><div>Open</div></li><li data-type="taskItem" data-checked="true" style="--en-checked:true;"><div>Done</div></li><li data-type="taskItem" data-checked="false" style="--en-checked:false;"><div>Later</div></li></ul><ul><li>Plain</li></ul>"#
        );
    }

    #[test]
    fn item_level_checklist_markers_and_nested_lists_are_handled() {
        let html = enml_to_html(
            r#"<en-note><ul><li style="--en-todo:true;--en-checked:true;">Done<ul><li>Plain child</li></ul></li><li style="--en-todo:true;">Later</li></ul></en-note>"#,
        );
        assert!(html.starts_with(r#"<ul data-type="taskList">"#));
        assert!(html.contains(r#"<li data-type="taskItem" data-checked="true" style="--en-todo:true;--en-checked:true;">Done<ul><li>Plain child</li></ul>"#));
        assert!(html.contains(
            r#"<li data-type="taskItem" data-checked="false" style="--en-todo:true;">Later"#
        ));
    }

    #[test]
    fn editor_html_becomes_well_formed_enml() {
        let html = concat!(
            r#"<h1 id="x" class="title" onclick="alert(1)">Title &amp; more</h1>"#,
            r##"<p style="text-align: center">Line<br>break <strong>bold</strong> <mark data-color="#fde68a" style="background-color: #fde68a; color: inherit">marked</mark> a &lt; b</p>"##,
            r#"<hr><img src="https://example.com/a.png?x=1&amp;y=2" alt="A &quot;quote&quot;">"#,
            r#"<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Done</p></div></li><li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>Open</p></div></li></ul>"#,
            r#"<pre><code class="language-rust">let a = 1 &lt; 2;
let b = "x";</code></pre>"#,
            r#"<table style="min-width: 50px"><colgroup><col style="min-width: 25px"><col></colgroup><tbody><tr><th colspan="1" rowspan="1" colwidth="120"><p>Head</p></th><td><p>Cell</p></td></tr></tbody></table>"#,
            r#"<p><en-media hash="abc" type="image/png" width="10"></en-media><en-todo checked="true"></en-todo><en-crypt hint="h" cipher="AES" length="128">c2VjcmV0</en-crypt></p>"#,
            r#"<section><script>alert(1)</script><style>p{}</style><iframe src="x"></iframe><custom-tag>kept text</custom-tag></section>"#,
        );
        let enml = html_to_enml(html);
        let names = enml_elements(&enml);
        for name in &names {
            assert!(
                ENML_ELEMENTS.contains(&name.as_str()),
                "{name} is not an ENML element"
            );
        }
        assert!(enml.starts_with("<?xml"));
        assert!(enml.contains("<h1>Title &amp; more</h1>"));
        assert!(enml.contains("Line<br/>break"));
        assert!(enml
            .contains(r#"<span style="--en-highlight:yellow;background-color: #fde68a; color: inherit">marked</span>"#));
        assert!(enml.contains("a &lt; b"));
        // Attributes are written in name order, so the output is deterministic.
        assert!(enml.contains(
            r#"<img alt="A &quot;quote&quot;" src="https://example.com/a.png?x=1&amp;y=2"/>"#
        ));
        assert!(enml.contains(r#"<ul style="--en-todo:true;"><li style="--en-checked:true;"><div><p>Done</p></div></li><li style="--en-checked:false;"><div><p>Open</p></div></li></ul>"#));
        assert!(enml.contains("<pre><code>let a = 1 &lt; 2;\nlet b = \"x\";</code></pre>"));
        assert!(enml.contains(r#"<th colspan="1" rowspan="1" style="width: 120px;">"#));
        assert!(enml.contains(r#"<en-media hash="abc" type="image/png" width="10"/>"#));
        assert!(enml.contains(r#"<en-todo checked="true"/>"#));
        assert!(
            enml.contains(r#"<en-crypt cipher="AES" hint="h" length="128">c2VjcmV0</en-crypt>"#)
        );
        assert!(enml.contains("<div>kept text</div>"));
        for forbidden in [
            "onclick", "class=", " id=", "data-", "<script", "<style", "<iframe", "<label",
            "<input",
        ] {
            assert!(
                !enml.contains(forbidden),
                "{forbidden} must not be exported"
            );
        }
    }

    #[test]
    fn exported_checklists_and_highlights_survive_reimport() {
        let html = r#"<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><div><p>Done</p></div></li></ul>"#;
        let reimported = enml_to_html(&html_to_enml(html));
        assert_eq!(
            reimported,
            r#"<ul data-type="taskList" style="--en-todo:true;"><li data-type="taskItem" data-checked="true" style="--en-checked:true;"><div><p>Done</p></div></li></ul>"#
        );
    }

    /// The editor keeps a web clipping as the markup Evernote wrote. Export
    /// and a later import must hand it back with its marker and its styles,
    /// or the clipping would come back as plain paragraphs.
    #[test]
    fn a_web_clipping_survives_export_and_reimport() {
        let clip = r##"<div style="--en-clipped-content:article; --en-clipped-source-url:https://example.com/a?x=1&amp;y=2; --en-clipped-source-title:A &quot;story&quot;;"><ul style="display:flex;list-style:none;"><li style="margin-left:10px;"><a href="https://example.com/b" rel="noopener" style="font-weight:700;">Section</a></li></ul><en-media hash="abcd1234" height="480" style="float:right;" type="image/png" width="640"></en-media><p style="font-family:&quot;Droid Serif&quot;, serif;">Clipped</p></div>"##;
        let html = format!("<p>Mine</p>{clip}");
        let enml = html_to_enml(&html);
        enml_elements(&enml);
        assert!(enml.contains("--en-clipped-content:article;"));
        assert!(enml.contains(r#"<ul style="display:flex;list-style:none;">"#));
        assert!(enml.contains(r#"hash="abcd1234""#));
        let reimported = enml_to_html(&enml);
        assert!(reimported.starts_with("<p>Mine</p><div style=\"--en-clipped-content:article;"));
        assert!(reimported.contains("--en-clipped-source-url:https://example.com/a?x=1&amp;y=2;"));
        assert!(reimported.contains(r#"<li style="margin-left:10px;">"#));
        assert!(reimported.contains(r#"style="font-family:&quot;Droid Serif&quot;, serif;""#));
        assert!(reimported.contains(r#"<en-media "#) && reimported.contains("</en-media>"));
    }

    /// A picture's width and alignment live on its `en-media`, in the form
    /// Evernote reads. The editor changes them; export must not lose them.
    #[test]
    fn a_picture_keeps_its_size_and_alignment_on_export() {
        let html = r#"<p><en-media hash="abcd1234" type="image/png" width="312px" style="--en-naturalWidth:643; --en-naturalHeight:150; --en-imageAlignment:center;"></en-media></p>"#;
        let enml = html_to_enml(html);
        enml_elements(&enml);
        assert!(enml.contains(r#"width="312px""#));
        assert!(enml.contains(
            r#"style="--en-naturalWidth:643; --en-naturalHeight:150; --en-imageAlignment:center;""#
        ));
        let reimported = enml_to_html(&enml);
        assert!(reimported.contains(r#"width="312px""#));
        assert!(reimported.contains("--en-imageAlignment:center;"));
    }

    #[test]
    fn an_empty_line_is_exported_the_way_evernote_writes_one() {
        let enml = html_to_enml("<p>One</p><p></p><p>Two</p><p style=\"text-align: center\"></p>");
        enml_elements(&enml);
        assert!(enml.contains("<p>One</p><div><br/></div><p>Two</p><div><br/></div></en-note>"));
        // And it comes back as an empty line, not as nothing.
        assert!(enml_to_html(&enml).contains("<p>One</p><div><br/></div><p>Two</p>"));
    }

    #[test]
    fn control_characters_never_break_the_export() {
        let enml = html_to_enml("<p>bell\u{7} null\u{0} ok</p>");
        enml_elements(&enml);
        assert!(enml.contains("<p>bell null ok</p>"));
    }

    #[test]
    fn links_resolve_by_guid_or_by_title() {
        let guid = "01234567-89ab-cdef-0123-456789abcdef";
        let html = format!(
            concat!(
                r#"<a href="evernote:///view/1/s2/{guid}/{guid}/">By GUID</a> "#,
                r#"<a style="color: blue" href="evernote:///view/1/s2/aaaaaaaa-89ab-cdef-0123-456789abcdef/aaaaaaaa-89ab-cdef-0123-456789abcdef/" rel="x"><span>Meeting  <b>Notes</b></span> &amp; Plans</a> "#,
                r#"<a href="https://www.evernote.com/shard/s2/nl/1/{guid}/">Web link</a> "#,
                r#"<a href="evernote:///view/1/s2/bbbbbbbb-89ab-cdef-0123-456789abcdef/bbbbbbbb-89ab-cdef-0123-456789abcdef/">Unknown</a> "#,
                r#"<a href="https://example.com/shard/">Other site</a>"#
            ),
            guid = guid
        );
        let (rewritten, changed) = rewrite_internal_links(&html, &|target, text| {
            if target == Some(guid) {
                Some("by-guid".to_owned())
            } else if text == "meeting notes & plans" {
                Some("by-title".to_owned())
            } else {
                None
            }
        });
        assert_eq!(changed, 3);
        assert!(rewritten.contains(r#"<a href="bever://note/by-guid">By GUID</a>"#));
        assert!(rewritten.contains(
            r#"<a style="color: blue" href="bever://note/by-title" rel="x"><span>Meeting  <b>Notes</b></span> &amp; Plans</a>"#
        ));
        assert!(rewritten.contains(r#"<a href="bever://note/by-guid">Web link</a>"#));
        assert!(rewritten.contains("bbbbbbbb-89ab-cdef-0123-456789abcdef/\">Unknown</a>"));
        assert!(rewritten.contains(r#"<a href="https://example.com/shard/">Other site</a>"#));
    }
}
