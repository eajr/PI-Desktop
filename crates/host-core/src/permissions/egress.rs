//! Tools whose only effect is sending model-chosen data to a third-party
//! service. Host-core never performs the request itself; it authorizes the
//! call through the normal permission gate and the caller makes the request
//! only after an allow decision.

use serde_json::{json, Value};

/// Agent-only TypeSafe Jev classifier (sidecar-executed after authorization).
pub const JEV_CLASSIFY_TOOL: &str = "JevClassify";

/// Host the Jev request goes to. Mirrors the host of
/// `TYPESAFE_SYSTEM_ONE_URL` in
/// `packages/shared/src/secret-refs.ts`; the sidecar cannot change it.
pub const JEV_DESTINATION_HOST: &str = "api.typesafe.ai";

/// Whether `tool_name` is a host-authorized third-party egress tool.
pub fn is_third_party_egress_tool(tool_name: &str) -> bool {
    tool_name == JEV_CLASSIFY_TOOL
}

/// Approval-card reason for an egress tool, naming the destination host.
pub fn permission_reason(tool_name: &str) -> Option<String> {
    (tool_name == JEV_CLASSIFY_TOOL)
        .then(|| format!("Sends data to a third-party service ({JEV_DESTINATION_HOST})"))
}

/// Approval-card preview for an egress tool. Destination and payload size are
/// computed here, not taken from the caller, so the card states what host-core
/// knows rather than what the requesting process claims.
pub fn permission_preview(tool_name: &str, args: &Value) -> Option<Value> {
    if tool_name != JEV_CLASSIFY_TOOL {
        return None;
    }
    let payload_bytes = serde_json::to_vec(args)
        .map(|bytes| bytes.len())
        .unwrap_or(0);
    Some(json!({
        "destination": JEV_DESTINATION_HOST,
        "payloadBytes": payload_bytes,
        "state": args.get("state").cloned().unwrap_or(Value::Null),
        "questions": args.get("questions").cloned().unwrap_or(Value::Null),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::{PermissionDecision, PermissionManager, Risk};
    use std::collections::HashMap;

    #[test]
    fn jev_preview_names_destination_and_payload_size_from_host() {
        let args = json!({
            "state": { "message": "hello" },
            "questions": { "q": { "type": "bool" } },
            "destination": "attacker.example",
        });
        let preview = permission_preview(JEV_CLASSIFY_TOOL, &args).unwrap();
        assert_eq!(preview["destination"], JEV_DESTINATION_HOST);
        assert_eq!(
            preview["payloadBytes"],
            serde_json::to_vec(&args).unwrap().len()
        );
        assert_eq!(preview["state"]["message"], "hello");
        assert!(permission_preview("Read", &args).is_none());
        assert!(permission_reason(JEV_CLASSIFY_TOOL)
            .unwrap()
            .contains(JEV_DESTINATION_HOST));
    }

    #[test]
    fn jev_requires_approval_except_under_auto_and_is_never_plan_safe() {
        assert!(matches!(
            PermissionManager::tool_risk_with_declared(JEV_CLASSIFY_TOOL, None),
            Risk::High
        ));
        let manager = PermissionManager::default();
        let grants = HashMap::new();
        for mode in ["ask", "accept-edits"] {
            assert!(manager
                .evaluate_auto_with_permission_mode("s", JEV_CLASSIFY_TOOL, "agent", mode, &grants)
                .is_none());
        }
        assert_eq!(
            manager.evaluate_auto_with_permission_mode(
                "s",
                JEV_CLASSIFY_TOOL,
                "agent",
                "auto",
                &grants
            ),
            Some(PermissionDecision::AllowOnce)
        );
        for mode in ["plan", "goal"] {
            assert_eq!(
                manager.evaluate_auto_with_permission_mode(
                    "s",
                    JEV_CLASSIFY_TOOL,
                    mode,
                    "auto",
                    &grants
                ),
                Some(PermissionDecision::Deny)
            );
        }
    }
}
