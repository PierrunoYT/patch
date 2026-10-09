use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Limits {
    pub memory_mb: u64,
    pub processes: u32,
    pub timeout_ms: u64,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: u64,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub network: bool,
    // Patch's filtering proxy (a named pipe) when the network is filtered by host (#97): the command then has no
    // network capability and reaches only this, through net-bridge. Never together with `network`.
    #[serde(default)]
    pub proxy: Option<String>,
    // The working folder may sit under application data (a sandboxed MCP server's own folder, #87). Still refuses
    // the user profile, a volume root, and application-data roots themselves.
    #[serde(default)]
    pub workspace: bool,
    #[serde(default)]
    pub read_write: Vec<String>,
    #[serde(default)]
    pub read_only: Vec<String>,
    // Narrow Program Files PATH entries: inspect package permissions, grant or stage read-only.
    #[serde(default)]
    pub toolchains: Vec<String>,
    // Paths inside a writable folder where writing is refused again (git hooks).
    #[serde(default)]
    pub deny_write: Vec<String>,
    #[serde(default)]
    pub limits: Limits,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct Kill {
    pub id: u64,
    pub kill: bool,
}

// The user closed or removed the project in Patch: remove its lasting write grant.
#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Revoke {
    pub revoke_project: String,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(untagged)]
pub enum Message {
    Kill(Kill),
    Revoke(Revoke),
    Run(Request),
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event<'a> {
    Started {
        id: u64,
        pid: u32,
    },
    Stdout {
        id: u64,
        data: &'a str,
    },
    Stderr {
        id: u64,
        data: &'a str,
    },
    #[serde(rename_all = "camelCase")]
    Exit {
        id: u64,
        exit_code: i64,
        timed_out: bool,
    },
    Error {
        id: Option<u64>,
        message: &'a str,
    },
    // Something Patch should write to its local log, never a failure of the command. Codes, record names and counts
    // only, no paths or other details.
    Log {
        code: &'a str,
        record: &'a str,
        failures: u32,
    },
}

pub fn parse_message(line: &str) -> Result<Message, String> {
    serde_json::from_str(line).map_err(|e| format!("Invalid request: {e}"))
}

pub fn encode_event(event: &Event) -> String {
    serde_json::to_string(event).expect("events always serialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_request() {
        let line = r#"{"id":3,"command":"C:\\a.exe","args":["x"],"cwd":"C:\\p","env":{"A":"1"},"network":true,"readWrite":["C:\\p"],"readOnly":["C:\\Windows"],"toolchains":["C:\\Program Files\\nodejs"],"limits":{"memoryMb":512,"processes":8,"timeoutMs":1000}}"#;
        let Message::Run(req) = parse_message(line).unwrap() else {
            panic!("not a run")
        };
        assert_eq!(req.id, 3);
        assert_eq!(req.args, vec!["x"]);
        assert!(req.network);
        assert_eq!(req.read_write, vec!["C:\\p"]);
        assert_eq!(req.toolchains, vec!["C:\\Program Files\\nodejs"]);
        assert_eq!(
            req.limits,
            Limits {
                memory_mb: 512,
                processes: 8,
                timeout_ms: 1000
            }
        );
    }

    #[test]
    fn optional_fields_default_to_the_safest_values() {
        let Message::Run(req) = parse_message(r#"{"id":1,"command":"a","cwd":"b"}"#).unwrap()
        else {
            panic!("not a run")
        };
        assert!(!req.network);
        assert!(req.proxy.is_none());
        assert!(!req.workspace);
        assert!(req.read_write.is_empty() && req.read_only.is_empty() && req.deny_write.is_empty());
        assert!(req.toolchains.is_empty());
        assert_eq!(req.limits, Limits::default());
    }

    #[test]
    fn parses_a_kill_message() {
        assert_eq!(
            parse_message(r#"{"id":2,"kill":true}"#).unwrap(),
            Message::Kill(Kill { id: 2, kill: true })
        );
    }

    #[test]
    fn parses_a_revoke_message_and_never_mistakes_a_run_for_one() {
        assert_eq!(
            parse_message(r#"{"revokeProject":"C:\\p"}"#).unwrap(),
            Message::Revoke(Revoke {
                revoke_project: r"C:\p".into()
            })
        );
        assert!(matches!(
            parse_message(r#"{"id":1,"command":"a","cwd":"C:\\p"}"#).unwrap(),
            Message::Run(_)
        ));
    }

    #[test]
    fn rejects_garbage_and_missing_fields() {
        assert!(parse_message("nope").is_err());
        assert!(parse_message(r#"{"id":1}"#).is_err());
    }

    #[test]
    fn encodes_events_as_camel_case_json() {
        assert_eq!(
            encode_event(&Event::Started { id: 1, pid: 9 }),
            r#"{"type":"started","id":1,"pid":9}"#
        );
        assert_eq!(
            encode_event(&Event::Exit {
                id: 1,
                exit_code: 2,
                timed_out: true
            }),
            r#"{"type":"exit","id":1,"exitCode":2,"timedOut":true}"#
        );
        assert_eq!(
            encode_event(&Event::Stdout {
                id: 1,
                data: "a\"b\n"
            }),
            r#"{"type":"stdout","id":1,"data":"a\"b\n"}"#
        );
        assert_eq!(
            encode_event(&Event::Log {
                code: "recovery-failed",
                record: "patch.sbx.1",
                failures: 2
            }),
            r#"{"type":"log","code":"recovery-failed","record":"patch.sbx.1","failures":2}"#
        );
    }
}
