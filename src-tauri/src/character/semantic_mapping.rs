use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::manifest::{is_opaque_pack_id, is_sha256};

pub const SEMANTIC_MAPPING_SCHEMA_VERSION: u16 = 1;
pub const MAX_MAPPING_VERSION: u64 = (1_u64 << 53) - 1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SemanticCueSelection {
    Neutral,
    Motion {
        #[serde(rename = "cueId")]
        cue_id: String,
    },
    Expression {
        #[serde(rename = "cueId")]
        cue_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SemanticAssignmentsV1 {
    pub neutral: SemanticCueSelection,
    pub thinking: SemanticCueSelection,
    pub working: SemanticCueSelection,
    pub asking: SemanticCueSelection,
    pub success: SemanticCueSelection,
    pub warning: SemanticCueSelection,
    pub error: SemanticCueSelection,
}

impl SemanticAssignmentsV1 {
    pub fn neutral() -> Self {
        Self {
            neutral: SemanticCueSelection::Neutral,
            thinking: SemanticCueSelection::Neutral,
            working: SemanticCueSelection::Neutral,
            asking: SemanticCueSelection::Neutral,
            success: SemanticCueSelection::Neutral,
            warning: SemanticCueSelection::Neutral,
            error: SemanticCueSelection::Neutral,
        }
    }

    pub fn hiyori_preset() -> Self {
        let motion = |cue_id: &str| SemanticCueSelection::Motion {
            cue_id: cue_id.to_owned(),
        };
        Self {
            neutral: motion("Idle[0]"),
            thinking: motion("Idle[1]"),
            working: motion("Tap@Body[0]"),
            asking: motion("FlickUp[0]"),
            success: motion("Tap[1]"),
            warning: motion("FlickDown[0]"),
            error: motion("Flick@Body[0]"),
        }
    }

    fn values(&self) -> [&SemanticCueSelection; 7] {
        [
            &self.neutral,
            &self.thinking,
            &self.working,
            &self.asking,
            &self.success,
            &self.warning,
            &self.error,
        ]
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SemanticMappingV1 {
    pub schema_version: u16,
    pub pack_id: String,
    pub manifest_hash: String,
    pub mapping_version: u64,
    pub assignments: SemanticAssignmentsV1,
}

impl SemanticMappingV1 {
    pub fn neutral(pack_id: String, manifest_hash: String) -> Self {
        Self {
            schema_version: SEMANTIC_MAPPING_SCHEMA_VERSION,
            pack_id,
            manifest_hash,
            mapping_version: 0,
            assignments: SemanticAssignmentsV1::neutral(),
        }
    }

    pub fn hiyori_preset(pack_id: String, manifest_hash: String) -> Self {
        Self {
            schema_version: SEMANTIC_MAPPING_SCHEMA_VERSION,
            pack_id,
            manifest_hash,
            mapping_version: 0,
            assignments: SemanticAssignmentsV1::hiyori_preset(),
        }
    }

    pub fn valid_for(&self, inventory: &SemanticCueInventory) -> bool {
        if self.schema_version != SEMANTIC_MAPPING_SCHEMA_VERSION
            || !is_opaque_pack_id(&self.pack_id)
            || !is_sha256(&self.manifest_hash)
            || self.mapping_version == 0
            || self.mapping_version > MAX_MAPPING_VERSION
        {
            return false;
        }
        let motions = inventory
            .motions
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let expressions = inventory
            .expressions
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        self.assignments.values().into_iter().all(|cue| match cue {
            SemanticCueSelection::Neutral => true,
            SemanticCueSelection::Motion { cue_id } => motions.contains(cue_id.as_str()),
            SemanticCueSelection::Expression { cue_id } => expressions.contains(cue_id.as_str()),
        })
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SemanticCueInventory {
    pub motions: Vec<String>,
    pub expressions: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticMappingStatus {
    Default,
    Saved,
    Invalid,
}
