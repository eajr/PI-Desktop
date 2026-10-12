//! `tools.execute` gate for third-party egress tools (JevClassify): host-core
//! authorizes the call through the normal permission flow and never performs
//! the request itself.

use super::*;
use crate::permissions::egress::{JEV_CLASSIFY_TOOL, JEV_DESTINATION_HOST};

fn session_with_permission_mode(
    permission_mode: &str,
) -> (tempfile::TempDir, Arc<Mutex<AppState>>, String) {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Jev gate".into()),
        Some("agent".into()),
        None,
        None,
        None,
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &app_state.db,
        &session.id,
        "agent",
        None,
        None,
        None,
        Some(permission_mode),
    )
    .unwrap();
    (data_dir, Arc::new(Mutex::new(app_state)), session.id)
}

fn jev_call(session_id: &str, tool_call_id: &str) -> Value {
    json!({
        "sessionId": session_id,
        "toolCallId": tool_call_id,
        "toolName": JEV_CLASSIFY_TOOL,
        "args": {
            "state": { "message": "The change works." },
            "questions": {
                "approved": {
                    "type": "bool",
                    "instructions": "Does the user approve?",
                    "criteria": { "true": "Approval", "false": "No approval" }
                }
            }
        },
        "mode": "agent"
    })
}

async fn run_with_decision(decision: &str) -> (Value, Value) {
    let (_dir, state, session_id) = session_with_permission_mode("ask");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let call = jev_call(&session_id, &format!("jev-{decision}"));
    let pending_state = state.clone();
    let task =
        tokio::spawn(async move { handle_request(pending_state, "tools.execute", call, tx).await });
    let notification = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    let notification: Value = serde_json::from_str(&notification).unwrap();
    assert_eq!(notification["method"], "permissions.request");
    let request_id = notification["params"]["requestId"]
        .as_str()
        .unwrap()
        .to_string();
    handle_request(
        state.clone(),
        "permissions.resolve",
        json!({ "requestId": request_id, "decision": decision }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let result = task.await.unwrap().unwrap();
    (notification["params"].clone(), result)
}

#[tokio::test]
async fn ask_mode_prompts_with_destination_and_payload_size_then_authorizes() {
    let (params, result) = run_with_decision("allow-once").await;
    assert_eq!(params["toolName"], JEV_CLASSIFY_TOOL);
    assert_eq!(params["risk"], "high");
    assert!(params["reason"]
        .as_str()
        .unwrap()
        .contains(JEV_DESTINATION_HOST));
    assert_eq!(params["argsPreview"]["destination"], JEV_DESTINATION_HOST);
    assert!(params["argsPreview"]["payloadBytes"].as_u64().unwrap() > 0);
    assert_eq!(
        params["argsPreview"]["state"]["message"],
        "The change works."
    );
    assert_eq!(result["ok"], true);
    assert_eq!(result["content"]["authorized"], true);
}

#[tokio::test]
async fn ask_mode_denial_is_reported_as_denied() {
    let (_, result) = run_with_decision("deny").await;
    assert_eq!(result["ok"], false);
    assert_eq!(result["denied"], true);
    assert_eq!(result["errorCode"], "TOOL_DENIED");
}

#[tokio::test]
async fn auto_mode_authorizes_without_a_prompt() {
    let (_dir, state, session_id) = session_with_permission_mode("auto");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let result = handle_request(
        state,
        "tools.execute",
        jev_call(&session_id, "jev-auto"),
        tx,
    )
    .await
    .unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(result["content"]["authorized"], true);
    while let Ok(message) = rx.try_recv() {
        let message: Value = serde_json::from_str(&message).unwrap();
        assert_ne!(message["method"], "permissions.request");
    }
}
