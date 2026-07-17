use serde_json::{json, Value};

/// Dynamic tools are deny-by-default. Product features must add a semantic tool
/// here together with a requirement, threat analysis, schema, handler timeout,
/// and fixtures. The protocol adapter never exposes shell, arbitrary files, or
/// arbitrary Tauri commands.
#[derive(Clone, Debug, Default)]
pub struct DynamicToolRegistry;

impl DynamicToolRegistry {
    pub const fn registered_tool_count(&self) -> usize {
        0
    }

    pub fn reject_unregistered(&self, params: &Value) -> Value {
        let valid_shape = params.as_object().is_some_and(|object| {
            ["threadId", "turnId", "callId", "tool", "arguments"]
                .iter()
                .all(|key| object.contains_key(*key))
                && object.keys().all(|key| {
                    [
                        "threadId",
                        "turnId",
                        "callId",
                        "tool",
                        "arguments",
                        "namespace",
                    ]
                    .contains(&key.as_str())
                })
        });
        let text = if valid_shape {
            "Dynamic tool is not registered by this application."
        } else {
            "Dynamic tool request was invalid."
        };
        json!({
            "contentItems": [{"type": "inputText", "text": text}],
            "success": false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_contains_no_generic_or_implicit_tools() {
        let registry = DynamicToolRegistry;
        assert_eq!(registry.registered_tool_count(), 0);
        assert_eq!(
            registry.reject_unregistered(&json!({
                "threadId": "t",
                "turnId": "u",
                "callId": "c",
                "tool": "shell",
                "arguments": {}
            }))["success"],
            false
        );
    }
}
