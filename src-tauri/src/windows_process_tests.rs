//! Exercise the production command builders from a console-less parent, as in
//! the GUI app. The Node fixture has no model, Pi loader, auth, or network code.
use super::{build_command, build_plain_command, PiCliCommandOptions, PiProcess, RpcStartOptions};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PROBE_ENV: &str = "PI_DESKTOP_CONSOLE_REGRESSION_PROBE";

fn bounded_output(mut command: Command, input: Option<&[u8]>) -> Output {
    let mut child = command.spawn().expect("spawn isolated process fixture");
    if let Some(bytes) = input {
        child.stdin.take().unwrap().write_all(bytes).unwrap();
    }
    // Drain concurrently: Windows anonymous pipes can fill before wait() even
    // for a panic report, which would otherwise hide the useful failure.
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let drain = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            pipe.read_to_end(&mut bytes).unwrap();
            bytes
        })
    };
    let stdout = drain(Box::new(stdout));
    let stderr = drain(Box::new(stderr));
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return Output {
                status,
                stdout: stdout.join().unwrap(),
                stderr: stderr.join().unwrap(),
            };
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "console regression child exceeded bounded 30 second deadline:\n{}\n{}",
                String::from_utf8_lossy(&stdout.join().unwrap()),
                String::from_utf8_lossy(&stderr.join().unwrap())
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn isolated_probe(test_name: &str) {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", test_name, "--nocapture"]);
    command.env_clear();
    for name in [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "ProgramFiles",
        "ProgramFiles(x86)",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    // DETACHED_PROCESS gives the test driver no inherited console. The actual
    // Node child is launched with the untouched production builder flags.
    command.creation_flags(0x00000008);
    command.env(PROBE_ENV, test_name);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = bounded_output(command, None);
    assert!(
        output.status.success(),
        "isolated probe failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("CONSOLE_PROBE_PASS branches=7"));
}

struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "pi-console-{}-{nonce}-中文 space & (fixture)",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        let koffi = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("node_modules/koffi");
        let script = format!(
            r#"
const koffi = require({});
const getConsoleWindow = koffi.load('kernel32.dll').func('uintptr_t __stdcall GetConsoleWindow()');
const timer = setTimeout(() => process.exit(2), 10000);
function finish(input) {{
  clearTimeout(timer);
  process.stderr.write('fixture-stderr');
  process.stdout.write(JSON.stringify({{consoleAttached: getConsoleWindow() != 0, args: process.argv.slice(2), cwd: process.cwd(), marker: process.env.PI_DESKTOP_CONSOLE_MARKER, input}}));
}}
if (process.argv.includes('--mode')) {{
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => finish(input));
}} else finish('');
"#,
            serde_json::to_string(&koffi.to_string_lossy()).unwrap()
        );
        fs::write(root.join("node_modules/console-probe.js"), script).unwrap();
        fs::write(
            root.join("pi.cmd"),
            "@echo off\r\nnode \"%~dp0\\node_modules\\console-probe.js\" %*\r\n",
        )
        .unwrap();
        // Deliberately not an npm-shaped script: exercise the existing cmd fallback.
        fs::write(
            root.join("fallback.cmd"),
            "@echo off\r\nnode node_modules/console-probe.js %*\r\n",
        )
        .unwrap();
        fs::copy(root.join("fallback.cmd"), root.join("fallback legacy.bat")).unwrap();
        Self { root }
    }

    fn variants(&self) -> Vec<PiProcess> {
        vec![
            PiProcess::PathBinary {
                path: self.root.join("pi.cmd"),
            },
            PiProcess::SidecarBinary {
                path: self.root.join("pi.cmd"),
            },
            // Keep relative-cwd lookup as well as the absolute-path regressions.
            PiProcess::PathBinary {
                path: PathBuf::from("fallback.cmd"),
            },
            PiProcess::PathBinary {
                path: self.root.join("fallback.cmd"),
            },
            PiProcess::SidecarBinary {
                path: self.root.join("fallback.cmd"),
            },
            PiProcess::PathBinary {
                path: self.root.join("fallback legacy.bat"),
            },
            PiProcess::DevNode {
                script: self
                    .root
                    .join("node_modules/console-probe.js")
                    .to_string_lossy()
                    .into_owned(),
            },
        ]
    }

    fn check(&self, output: Output, args: Value, input: &str) {
        assert!(
            output.status.success(),
            "fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stderr, b"fixture-stderr", "stderr pipe changed");
        let result: Value =
            serde_json::from_slice(&output.stdout).expect("one JSON response on stdout");
        assert_eq!(
            result["consoleAttached"], false,
            "RPC/CLI child allocated or inherited a console"
        );
        assert_eq!(
            result["args"], args,
            "provider/model/session arguments changed"
        );
        assert_eq!(result["cwd"], self.root.to_string_lossy().as_ref());
        assert_eq!(result["marker"], "fixture-only");
        assert_eq!(result["input"], input, "stdin pipe changed");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Remove only this test's uniquely created immediate TEMP child;
        // never use a caller-provided cleanup path.
        if self.root.parent() == Some(std::env::temp_dir().as_path())
            && self
                .root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("pi-console-")
        {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

#[test]
fn rpc_children_are_console_free_and_keep_pipes() {
    let name = "windows_process_tests::rpc_children_are_console_free_and_keep_pipes";
    if std::env::var(PROBE_ENV).as_deref() != Ok(name) {
        isolated_probe(name);
        return;
    }
    let fixture = Fixture::new();
    let session = fixture
        .root
        .join("session with space.jsonl")
        .to_string_lossy()
        .into_owned();
    let options = RpcStartOptions {
        cli_path: None,
        pi_path: None,
        cwd: fixture.root.to_string_lossy().into_owned(),
        provider: Some("synthetic-only".into()),
        model: Some("no-network".into()),
        session_path: Some(session.clone()),
        env: Some(HashMap::from([(
            "PI_DESKTOP_CONSOLE_MARKER".into(),
            "fixture-only".into(),
        )])),
    };
    let input = "{\"type\":\"get_state\"}\n";
    for pi in fixture.variants() {
        let output = bounded_output(build_command(&pi, &options), Some(input.as_bytes()));
        fixture.check(
            output,
            json!([
                "--mode",
                "rpc",
                "--provider",
                "synthetic-only",
                "--model",
                "no-network",
                "--session",
                session
            ]),
            input,
        );
    }
    println!("CONSOLE_PROBE_PASS branches=7");
}

#[test]
fn cli_children_are_console_free_and_keep_output() {
    let name = "windows_process_tests::cli_children_are_console_free_and_keep_output";
    if std::env::var(PROBE_ENV).as_deref() != Ok(name) {
        isolated_probe(name);
        return;
    }
    let fixture = Fixture::new();
    let options = PiCliCommandOptions {
        cli_path: None,
        pi_path: None,
        cwd: Some(fixture.root.to_string_lossy().into_owned()),
        args: vec![
            "--version".into(),
            "argument with 中文 space".into(),
            "".into(),
            "literal&operator|<input>".into(),
            "%PI_DESKTOP_CONSOLE_MARKER%".into(),
            "!literal!^caret (group)".into(),
            "trailing space \\".into(),
        ],
        env: Some(HashMap::from([(
            "PI_DESKTOP_CONSOLE_MARKER".into(),
            "fixture-only".into(),
        )])),
    };
    for pi in fixture.variants() {
        let output = bounded_output(build_plain_command(&pi, &options), None);
        fixture.check(output, json!(options.args), "");
    }
    println!("CONSOLE_PROBE_PASS branches=7");
}
