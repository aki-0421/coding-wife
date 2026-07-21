use sha2::{Digest, Sha256};
use tauri::http::{self, header::CONTENT_TYPE};

#[derive(Clone, Copy)]
struct ReviewedAsset {
    path: &'static str,
    content_type: &'static str,
    sha256: &'static str,
}

const REVIEWED_ASSETS: &[ReviewedAsset] = &[
    ReviewedAsset {
        path: "/characters/builtin-hiyori/runtime/hiyori_pro_t11.moc3",
        content_type: "application/octet-stream",
        sha256: "608d62c9a65cf537ac25ca9e710e687dbef98ee0a0575e0ee8e27bfdc446cd5e",
    },
    ReviewedAsset {
        path: "/vendor/live2d/shaders/webgl/fragshadersrcalphablend.frag",
        content_type: "text/plain",
        sha256: "855b247f02042a808a41e282ee4d7de7cc4533abeb5032b4ab8fe84f7dec107f",
    },
    ReviewedAsset {
        path: "/vendor/live2d/shaders/webgl/fragshadersrccolorblend.frag",
        content_type: "text/plain",
        sha256: "01d4bf6a14b4a738976e9a538767a21da0defa8816f3845a7df08a7713327538",
    },
    ReviewedAsset {
        path: "/vendor/live2d/shaders/webgl/fragshadersrccopy.frag",
        content_type: "text/plain",
        sha256: "15c67a4ec3adda4c849aff2a8319a3f6aceef8a84d5e5e1f3fb7fd9cd681193c",
    },
    ReviewedAsset {
        path: "/vendor/live2d/shaders/webgl/fragshadersrcmaskinvertedpremultipliedalpha.frag",
        content_type: "text/plain",
        sha256: "1005cff8113de587cf1c0e295288d04d85f0f4ebc223684c8340e017fd8fc788",
    },
    ReviewedAsset {
        path: "/vendor/live2d/shaders/webgl/fragshadersrcmaskpremultipliedalpha.frag",
        content_type: "text/plain",
        sha256: "f84ff615393d26ea6ab7c28747803db6472524c92567c0ad01e8225fbab36a3b",
    },
    ReviewedAsset {
        path: "/vendor/live2d/shaders/webgl/fragshadersrcpremultipliedalpha.frag",
        content_type: "text/plain",
        sha256: "c93abe215357cc782a25fc4ef20f5fe1f34e2cc193ee23d763b56b81fae5fce1",
    },
    ReviewedAsset {
        path: "/vendor/live2d/shaders/webgl/fragshadersrcpremultipliedalphablend.frag",
        content_type: "text/plain",
        sha256: "2155076275199a2946959838391dfb856e9d1db91b6ca3abd19ed70d4ff27e15",
    },
    ReviewedAsset {
        path: "/vendor/live2d/shaders/webgl/fragshadersrcsetupmask.frag",
        content_type: "text/plain",
        sha256: "3cccc0b68a56cfbf4bd4841b0a759431dd159812c38dc280981ba633fa0afe7a",
    },
    ReviewedAsset {
        path: "/vendor/live2d/shaders/webgl/vertshadersrc.vert",
        content_type: "text/plain",
        sha256: "291ed3f35f71f1e71e6df33fb055f009a8a9b36ee664f74f24f6cefef0c4029b",
    },
    ReviewedAsset {
        path: "/vendor/live2d/shaders/webgl/vertshadersrcblend.vert",
        content_type: "text/plain",
        sha256: "2589837bd7a6a550a1c3af41b4fa776011e6e71f2531320fa39afcb83b209bf4",
    },
    ReviewedAsset {
        path: "/vendor/live2d/shaders/webgl/vertshadersrccopy.vert",
        content_type: "text/plain",
        sha256: "b7bc4ba7517f405af4812ac47d99bc2b633c99f463c1224029556b00e8dff3cf",
    },
    ReviewedAsset {
        path: "/vendor/live2d/shaders/webgl/vertshadersrcmasked.vert",
        content_type: "text/plain",
        sha256: "6704a9df2e6d3ee5176c72fca4ba59358ba4827a07054b1e0a72a3c574e281fd",
    },
    ReviewedAsset {
        path: "/vendor/live2d/shaders/webgl/vertshadersrcsetupmask.vert",
        content_type: "text/plain",
        sha256: "649aad2f6c0af55a7a4adcf33dbf78937ef9d77ed6ba917fd716176adce25afe",
    },
];

fn is_tauri_asset_origin(uri: &http::Uri) -> bool {
    uri.port().is_none()
        && matches!(
            (uri.scheme_str(), uri.host()),
            (Some("tauri"), Some("localhost")) | (Some("http"), Some("tauri.localhost"))
        )
}

pub(crate) fn correct_reviewed_live2d_content_type<B: AsRef<[u8]>>(
    request: &http::Request<Vec<u8>>,
    response: &mut http::Response<B>,
) {
    if request.method() != http::Method::GET
        || response.status() != http::StatusCode::OK
        || !is_tauri_asset_origin(request.uri())
    {
        return;
    }
    let Some(asset) = REVIEWED_ASSETS
        .iter()
        .find(|asset| asset.path == request.uri().path())
    else {
        return;
    };

    // Tauri 2.11 labels unknown extensions as text/html. Retype only the
    // byte-exact reviewed asset so an SPA fallback can never inherit trust.
    let actual_sha256 = hex::encode(Sha256::digest(response.body().as_ref()));
    if actual_sha256 != asset.sha256 {
        return;
    }
    response.headers_mut().insert(
        CONTENT_TYPE,
        http::HeaderValue::from_static(asset.content_type),
    );
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use super::*;

    fn canonical_asset_bytes(asset: ReviewedAsset) -> Vec<u8> {
        let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let path = if let Some(relative) = asset.path.strip_prefix("/characters/builtin-hiyori/") {
            crate_root
                .join("resources/characters/builtin-hiyori")
                .join(relative)
        } else {
            crate_root.join("../public").join(
                asset
                    .path
                    .strip_prefix('/')
                    .expect("reviewed asset path must be absolute"),
            )
        };
        fs::read(path).expect("reviewed asset fixture must be readable")
    }

    fn request(uri: &str) -> http::Request<Vec<u8>> {
        http::Request::get(uri)
            .body(Vec::new())
            .expect("asset request must build")
    }

    fn response(bytes: Vec<u8>) -> http::Response<Vec<u8>> {
        http::Response::builder()
            .header(CONTENT_TYPE, "text/html")
            .body(bytes)
            .expect("asset response must build")
    }

    #[test]
    fn accepts_only_supported_url_origins_without_explicit_ports() {
        let accepted = [
            "tauri://localhost/reviewed.asset",
            "http://tauri.localhost/reviewed.asset",
        ];
        for uri in accepted {
            assert!(is_tauri_asset_origin(request(uri).uri()), "{uri}");
        }

        let rejected = [
            "tauri://localhost:1420/reviewed.asset",
            "http://tauri.localhost:80/reviewed.asset",
            "http://tauri.localhost:1420/reviewed.asset",
            "https://tauri.localhost/reviewed.asset",
            "tauri://localhost.attacker.test/reviewed.asset",
            "http://tauri.localhost.attacker.test/reviewed.asset",
            "tauri://tauri.localhost/reviewed.asset",
            "http://localhost/reviewed.asset",
        ];
        for uri in rejected {
            assert!(!is_tauri_asset_origin(request(uri).uri()), "{uri}");
        }
    }

    #[test]
    fn corrects_every_byte_exact_reviewed_asset() {
        for asset in REVIEWED_ASSETS {
            let mut response = response(canonical_asset_bytes(*asset));
            correct_reviewed_live2d_content_type(
                &request(&format!("tauri://localhost{}", asset.path)),
                &mut response,
            );

            assert_eq!(
                response.headers().get(CONTENT_TYPE),
                Some(&http::HeaderValue::from_static(asset.content_type)),
                "{}",
                asset.path
            );
        }
    }

    #[test]
    fn supports_the_translated_windows_asset_origin() {
        let asset = REVIEWED_ASSETS[0];
        let mut response = response(canonical_asset_bytes(asset));
        correct_reviewed_live2d_content_type(
            &request(&format!("http://tauri.localhost{}", asset.path)),
            &mut response,
        );

        assert_eq!(
            response.headers().get(CONTENT_TYPE),
            Some(&http::HeaderValue::from_static(asset.content_type))
        );
    }

    #[test]
    fn preserves_the_existing_header_for_non_get_or_non_ok_responses() {
        let asset = REVIEWED_ASSETS[0];
        let uri = format!("tauri://localhost{}", asset.path);
        let canonical = canonical_asset_bytes(asset);

        let post = http::Request::post(&uri)
            .body(Vec::new())
            .expect("POST asset request must build");
        let mut post_response = response(canonical.clone());
        correct_reviewed_live2d_content_type(&post, &mut post_response);
        assert_eq!(
            post_response.headers().get(CONTENT_TYPE),
            Some(&http::HeaderValue::from_static("text/html"))
        );

        let mut non_ok_response = response(canonical);
        *non_ok_response.status_mut() = http::StatusCode::NOT_FOUND;
        correct_reviewed_live2d_content_type(&request(&uri), &mut non_ok_response);
        assert_eq!(
            non_ok_response.headers().get(CONTENT_TYPE),
            Some(&http::HeaderValue::from_static("text/html"))
        );
    }

    #[test]
    fn does_not_retype_html_fallbacks_or_unreviewed_requests() {
        let asset = REVIEWED_ASSETS[0];
        let canonical = canonical_asset_bytes(asset);
        let cases = [
            (
                format!("tauri://localhost{}", asset.path),
                b"<!doctype html><title>fallback</title>".to_vec(),
            ),
            (
                format!("https://attacker.test{}", asset.path),
                canonical.clone(),
            ),
            (
                format!("https://tauri.localhost{}", asset.path),
                canonical.clone(),
            ),
            (
                format!("tauri://localhost:1420{}", asset.path),
                canonical.clone(),
            ),
            (
                format!("http://tauri.localhost:80{}", asset.path),
                canonical.clone(),
            ),
            (
                format!("http://tauri.localhost:1420{}", asset.path),
                canonical.clone(),
            ),
            (
                format!("tauri://localhost.attacker.test{}", asset.path),
                canonical.clone(),
            ),
            (
                "tauri://localhost/characters/builtin-hiyori/runtime/%2e%2e/runtime/hiyori_pro_t11.moc3"
                    .to_owned(),
                canonical.clone(),
            ),
            (
                format!("tauri://localhost{}.unreviewed", asset.path),
                canonical,
            ),
        ];

        for (uri, bytes) in cases {
            let mut response = response(bytes);
            correct_reviewed_live2d_content_type(&request(&uri), &mut response);
            assert_eq!(
                response.headers().get(CONTENT_TYPE),
                Some(&http::HeaderValue::from_static("text/html")),
                "{uri}"
            );
        }
    }
}
