//! ListObjectsV2 response parsing.

use super::S3Error;

pub struct ObjectInfo {
    pub key: String,
    pub size: u64,
    pub etag: String,
    /// ISO8601 as returned by the provider, stored verbatim.
    pub last_modified: String,
}

pub struct ListPage {
    pub objects: Vec<ObjectInfo>,
    pub next_continuation_token: Option<String>,
    pub is_truncated: bool,
}

pub fn parse_list_response(xml: &[u8]) -> Result<ListPage, S3Error> {
    let xml_string = String::from_utf8(xml.to_vec())
        .map_err(|e| S3Error::InvalidResponse(format!("invalid UTF-8: {e}")))?;

    let doc = roxmltree::Document::parse(&xml_string)
        .map_err(|e| S3Error::InvalidResponse(format!("XML parse error: {e}")))?;

    let root = doc.root_element();
    let mut page = ListPage {
        objects: Vec::new(),
        next_continuation_token: None,
        is_truncated: false,
    };

    // Helper to get element text content (handles entities automatically)
    let get_text =
        |elem: roxmltree::Node| -> String { elem.text().unwrap_or_default().to_string() };

    // Parse child elements
    for child in root.children() {
        if child.is_element() {
            let tag_name = child.tag_name().name();
            match tag_name {
                "IsTruncated" => {
                    page.is_truncated = get_text(child).trim() == "true";
                }
                "NextContinuationToken" => {
                    let text = get_text(child).trim().to_string();
                    if !text.is_empty() {
                        page.next_continuation_token = Some(text);
                    }
                }
                "Contents" => {
                    let mut obj_key = String::new();
                    let mut obj_etag = String::new();
                    let mut obj_last_modified = String::new();
                    let mut obj_size: u64 = 0;

                    for field in child.children() {
                        if field.is_element() {
                            let field_tag = field.tag_name().name();
                            let text = get_text(field);
                            match field_tag {
                                "Key" => obj_key = text,
                                "ETag" => obj_etag = text,
                                "LastModified" => obj_last_modified = text,
                                "Size" => {
                                    obj_size = text.trim().parse().map_err(|_| {
                                        S3Error::InvalidResponse(format!("bad Size: {text}"))
                                    })?;
                                }
                                _ => {}
                            }
                        }
                    }

                    if !obj_key.is_empty() {
                        page.objects.push(ObjectInfo {
                            key: obj_key,
                            size: obj_size,
                            etag: obj_etag,
                            last_modified: obj_last_modified,
                        });
                    }
                }
                _ => {}
            }
        }
    }

    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>photos</Name>
  <Prefix></Prefix>
  <KeyCount>2</KeyCount>
  <MaxKeys>2</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>token-abc/123=</NextContinuationToken>
  <Contents>
    <Key>docs/a &amp; b.txt</Key>
    <LastModified>2026-07-14T18:22:00.000Z</LastModified>
    <ETag>&quot;9b2cf535f27731c974343645a3985328&quot;</ETag>
    <Size>1024</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>photos/IMG_0142.jpg</Key>
    <LastModified>2026-07-14T18:25:00.000Z</LastModified>
    <ETag>&quot;deadbeef&quot;</ETag>
    <Size>4194304</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>"#;

    #[test]
    fn parses_objects_with_unescaped_entities() {
        let page = parse_list_response(PAGE_XML.as_bytes()).unwrap();
        assert_eq!(page.objects.len(), 2);
        assert_eq!(page.objects[0].key, "docs/a & b.txt");
        assert_eq!(page.objects[0].size, 1024);
        assert_eq!(page.objects[0].etag, "\"9b2cf535f27731c974343645a3985328\"");
        assert_eq!(page.objects[0].last_modified, "2026-07-14T18:22:00.000Z");
        assert_eq!(page.objects[1].key, "photos/IMG_0142.jpg");
    }

    #[test]
    fn parses_pagination_fields() {
        let page = parse_list_response(PAGE_XML.as_bytes()).unwrap();
        assert!(page.is_truncated);
        assert_eq!(
            page.next_continuation_token.as_deref(),
            Some("token-abc/123=")
        );
    }

    #[test]
    fn parses_empty_bucket() {
        let xml = r#"<?xml version="1.0"?>
<ListBucketResult><Name>photos</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>"#;
        let page = parse_list_response(xml.as_bytes()).unwrap();
        assert!(page.objects.is_empty());
        assert!(!page.is_truncated);
        assert!(page.next_continuation_token.is_none());
    }

    #[test]
    fn rejects_malformed_xml() {
        // Mismatched close tag — roxmltree should report an error
        let xml = b"<ListBucketResult><Contents></Wrong></ListBucketResult>";
        assert!(parse_list_response(xml).is_err());
    }

    #[test]
    fn rejects_non_numeric_size() {
        let xml = r#"<ListBucketResult><Contents><Key>k</Key><Size>big</Size></Contents></ListBucketResult>"#;
        assert!(parse_list_response(xml.as_bytes()).is_err());
    }
}
