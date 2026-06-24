use std::{
    collections::{HashMap, HashSet},
    env, fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, TimeDelta, Utc};
use crossterm::{
    event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    Frame, Terminal,
    backend::CrosstermBackend,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    symbols,
    text::{Line, Span, Text},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};
use reqwest::{
    Client, Method, StatusCode, Url,
    header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::time::sleep;

const DEFAULT_URL: &str = "https://eng.impo.ai";
const DEFAULT_REFRESH_MS: u64 = 4000;
const DEFAULT_LINES: u16 = 160;
const LOGIN_POLL_FLOOR_MS: u64 = 1000;
const CARD_HEIGHT: u16 = 14;
const CARD_MIN_WIDTH: u16 = 42;

static DARK_THEME: AtomicBool = AtomicBool::new(true);

#[derive(Debug, Clone, Copy)]
enum ThemeChoice {
    Dark,
    Light,
}

impl ThemeChoice {
    fn parse(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "dark" => Ok(Self::Dark),
            "light" | "kami" => Ok(Self::Light),
            other => bail!("unknown theme: {other}"),
        }
    }
}

fn set_theme(theme: ThemeChoice) {
    DARK_THEME.store(matches!(theme, ThemeChoice::Dark), Ordering::Relaxed);
}

fn is_dark_theme() -> bool {
    DARK_THEME.load(Ordering::Relaxed)
}

fn toggle_theme() {
    DARK_THEME.fetch_xor(true, Ordering::Relaxed);
}

fn theme_name() -> &'static str {
    if is_dark_theme() { "dark" } else { "light" }
}

fn ink() -> Color {
    if is_dark_theme() {
        Color::Rgb(232, 236, 241)
    } else {
        Color::Rgb(38, 40, 43)
    }
}

fn muted() -> Color {
    if is_dark_theme() {
        Color::Rgb(147, 157, 171)
    } else {
        Color::Rgb(111, 118, 128)
    }
}

fn surface() -> Color {
    if is_dark_theme() {
        Color::Rgb(14, 18, 24)
    } else {
        Color::Rgb(252, 251, 247)
    }
}

fn surface_soft() -> Color {
    if is_dark_theme() {
        Color::Rgb(25, 32, 42)
    } else {
        Color::Rgb(244, 246, 248)
    }
}

fn line() -> Color {
    if is_dark_theme() {
        Color::Rgb(57, 68, 83)
    } else {
        Color::Rgb(202, 207, 214)
    }
}

fn blue() -> Color {
    if is_dark_theme() {
        Color::Rgb(92, 176, 255)
    } else {
        Color::Rgb(35, 131, 226)
    }
}

fn green() -> Color {
    if is_dark_theme() {
        Color::Rgb(78, 201, 143)
    } else {
        Color::Rgb(28, 135, 93)
    }
}

fn red() -> Color {
    if is_dark_theme() {
        Color::Rgb(255, 116, 116)
    } else {
        Color::Rgb(167, 53, 53)
    }
}

fn amber() -> Color {
    if is_dark_theme() {
        Color::Rgb(245, 180, 72)
    } else {
        Color::Rgb(180, 116, 24)
    }
}

#[derive(Debug)]
struct Args {
    url: String,
    login: bool,
    token: Option<String>,
    refresh_ms: u64,
    lines: u16,
    theme: ThemeChoice,
    help: bool,
}

impl Args {
    fn parse() -> Result<Self> {
        let mut args = Args {
            url: env::var("TMUX_MOBILE_URL").unwrap_or_else(|_| DEFAULT_URL.to_string()),
            login: false,
            token: env::var("TMUX_MOBILE_SESSION_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
            refresh_ms: DEFAULT_REFRESH_MS,
            lines: DEFAULT_LINES,
            theme: env::var("TMUX_MOBILE_TUI_THEME")
                .ok()
                .as_deref()
                .map(ThemeChoice::parse)
                .transpose()?
                .unwrap_or(ThemeChoice::Dark),
            help: false,
        };
        let mut iter = env::args().skip(1);
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--url" => {
                    args.url = iter
                        .next()
                        .ok_or_else(|| anyhow!("--url requires a value"))?;
                }
                "--login" => args.login = true,
                "--token" => {
                    args.token = Some(
                        iter.next()
                            .ok_or_else(|| anyhow!("--token requires a value"))?,
                    );
                }
                "--refresh-ms" => {
                    let raw = iter
                        .next()
                        .ok_or_else(|| anyhow!("--refresh-ms requires a value"))?;
                    args.refresh_ms = raw.parse::<u64>().context("invalid --refresh-ms")?;
                }
                "--lines" => {
                    let raw = iter
                        .next()
                        .ok_or_else(|| anyhow!("--lines requires a value"))?;
                    args.lines = clamp_lines(raw.parse::<u16>().context("invalid --lines")?);
                }
                "--theme" => {
                    let raw = iter
                        .next()
                        .ok_or_else(|| anyhow!("--theme requires a value"))?;
                    args.theme = ThemeChoice::parse(&raw)?;
                }
                "--help" | "-h" => args.help = true,
                value if value.starts_with('-') => bail!("unknown argument: {value}"),
                value => args.url = value.to_string(),
            }
        }
        args.refresh_ms = args.refresh_ms.clamp(1000, 60_000);
        Ok(args)
    }
}

fn usage() {
    println!(
        r#"Usage: npm run terminal:tui -- [controller-url] [options]

Options:
  --url URL          Controller/local server URL. Default: {DEFAULT_URL}
  --login            Force Google device login before connecting
  --token TOKEN      Use an existing tmux-mobile session bearer token
  --refresh-ms N     Dashboard refresh interval. Default: {DEFAULT_REFRESH_MS}
  --lines N          Capture line count for pane view. Default: {DEFAULT_LINES}
  --theme THEME      dark or light. Default: dark

Keys:
  j/k or arrows      Move between cards
  h/l                Jump a row up/down in the card grid
  Enter or o         Open selected agent pane
  r                  Interact: send text to the selected agent pane
  t                  List the selected conversation transcript
  c                  Compact list of all visible conversations
  m                  Select/filter by machine
  /                  Filter conversations by text
  d                  Toggle dark/light theme
  u or Ctrl-R        Refresh now
  Esc                Leave pane view or cancel input
  q or Ctrl-C        Quit
"#
    );
}

#[derive(Debug, Clone)]
struct ApiError {
    status: Option<StatusCode>,
    message: String,
}

impl ApiError {
    fn connection(base_url: &Url, error: reqwest::Error) -> Self {
        let local_hint = match base_url.host_str() {
            Some("127.0.0.1") | Some("localhost") => {
                " Start the local server with `npm start`, or pass a controller URL."
            }
            _ => "",
        };
        Self {
            status: None,
            message: format!(
                "Could not connect to {} ({}).{}",
                controller_key(base_url),
                error,
                local_hint
            ),
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ApiError {}

type ApiResult<T> = std::result::Result<T, ApiError>;

#[derive(Clone)]
struct ApiClient {
    base_url: Url,
    http: Client,
    token: Option<String>,
}

impl ApiClient {
    fn new(base_url: Url, token: Option<String>) -> Self {
        Self {
            base_url,
            http: Client::new(),
            token,
        }
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        self.base_url
            .join(path.trim_start_matches('/'))
            .with_context(|| format!("invalid endpoint: {path}"))
    }

    async fn request_json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        machine_id: Option<&str>,
        body: Option<Value>,
    ) -> ApiResult<T> {
        let url = self.endpoint(path).map_err(|error| ApiError {
            status: None,
            message: error.to_string(),
        })?;
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(token) = &self.token {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}")).map_err(|error| ApiError {
                    status: None,
                    message: format!("invalid bearer token: {error}"),
                })?,
            );
        }
        if let Some(machine_id) = machine_id.filter(|id| !id.is_empty() && *id != "local") {
            headers.insert(
                "x-machine-id",
                HeaderValue::from_str(machine_id).map_err(|error| ApiError {
                    status: None,
                    message: format!("invalid machine id header: {error}"),
                })?,
            );
        }
        let mut request = self.http.request(method, url).headers(headers);
        if let Some(body) = body {
            request = request.header(CONTENT_TYPE, "application/json").json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| ApiError::connection(&self.base_url, error))?;
        decode_response(response).await
    }

    async fn public_post<T: DeserializeOwned>(&self, path: &str, body: Value) -> ApiResult<T> {
        let url = self.endpoint(path).map_err(|error| ApiError {
            status: None,
            message: error.to_string(),
        })?;
        let response = self
            .http
            .post(url)
            .header(ACCEPT, "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| ApiError::connection(&self.base_url, error))?;
        decode_response(response).await
    }
}

async fn decode_response<T: DeserializeOwned>(response: reqwest::Response) -> ApiResult<T> {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(ApiError {
            status: Some(status),
            message,
        });
    }
    serde_json::from_str::<T>(&text).map_err(|error| ApiError {
        status: Some(status),
        message: format!("invalid JSON response: {error}"),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceStart {
    id: String,
    verification_url: Option<String>,
    verification_url_complete: Option<String>,
    user_code: Option<String>,
    interval: Option<u64>,
    expires_in: Option<u64>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DevicePoll {
    session_token: Option<String>,
    session_expires_in: Option<i64>,
    user: Option<Value>,
    interval: Option<u64>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct TerminalConfig {
    #[serde(default)]
    controllers: HashMap<String, StoredSession>,
    // Card keys the user has starred. Mirrors the web Command Center's
    // machine-scoped stars (the key already embeds the machine), kept here so
    // starred cards float to the top of the dashboard like they do on the web.
    #[serde(default)]
    starred: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    session_token: Option<String>,
    user: Option<Value>,
    expires_at: Option<String>,
    saved_at: Option<String>,
}

fn config_path() -> Result<PathBuf> {
    if let Ok(value) = env::var("TMUX_MOBILE_TERMINAL_CONFIG") {
        return Ok(PathBuf::from(value));
    }
    Ok(home_dir()?.join(".config/tmux-mobile/terminal.json"))
}

fn home_dir() -> Result<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
        .ok_or_else(|| anyhow!("HOME is not set"))
}

fn load_config(path: &Path) -> Result<TerminalConfig> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(TerminalConfig::default()),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

fn save_config(path: &Path, config: &TerminalConfig) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(config)?;
    fs::write(path, format!("{text}\n")).with_context(|| format!("write {}", path.display()))
}

fn stored_session(config: &TerminalConfig, base_url: &Url) -> Option<String> {
    let item = config.controllers.get(&controller_key(base_url))?;
    let token = item.session_token.as_deref()?.to_string();
    if let Some(expires_at) = &item.expires_at {
        let expires_at = DateTime::parse_from_rfc3339(expires_at).ok()?;
        if expires_at.with_timezone(&Utc) <= Utc::now() + TimeDelta::seconds(60) {
            return None;
        }
    }
    Some(token)
}

fn store_session(
    config: &mut TerminalConfig,
    base_url: &Url,
    poll: &DevicePoll,
    path: &Path,
) -> Result<()> {
    let expires_in = poll.session_expires_in.unwrap_or(0).max(0);
    let now = Utc::now();
    let item = StoredSession {
        session_token: poll.session_token.clone(),
        user: poll.user.clone(),
        expires_at: Some((now + TimeDelta::seconds(expires_in)).to_rfc3339()),
        saved_at: Some(now.to_rfc3339()),
    };
    config.controllers.insert(controller_key(base_url), item);
    save_config(path, config)
}

async fn ensure_runtime(
    client: &mut ApiClient,
    config: &mut TerminalConfig,
    config_path: &Path,
    args: &Args,
) -> Result<RuntimeInfo> {
    if client.token.is_none() {
        client.token = stored_session(config, &client.base_url);
    }
    if args.login {
        login_terminal(client, config, config_path).await?;
    }
    match client
        .request_json(Method::GET, "/api/runtime", None, None)
        .await
    {
        Ok(runtime) => Ok(runtime),
        Err(error) if error.status == Some(StatusCode::UNAUTHORIZED) => {
            login_terminal(client, config, config_path).await?;
            client
                .request_json(Method::GET, "/api/runtime", None, None)
                .await
                .map_err(anyhow::Error::new)
        }
        Err(error) => Err(anyhow::Error::new(error)),
    }
}

async fn login_terminal(
    client: &mut ApiClient,
    config: &mut TerminalConfig,
    config_path: &Path,
) -> Result<()> {
    let start: DeviceStart = client
        .public_post("/auth/device/start", json!({}))
        .await
        .map_err(anyhow::Error::new)?;
    println!("tmux-mobile TUI needs Google device login.");
    println!("Controller: {}", controller_key(&client.base_url));
    let verification = start
        .verification_url_complete
        .as_deref()
        .or(start.verification_url.as_deref())
        .unwrap_or("");
    println!("Open in a browser: {verification}");
    if start.verification_url_complete.is_none() {
        if let Some(code) = &start.user_code {
            println!("Enter code: {code}");
        }
    }
    println!("Waiting for Google authorization...");

    let mut interval_ms = start.interval.unwrap_or(5) * 1000;
    interval_ms = interval_ms.max(LOGIN_POLL_FLOOR_MS);
    let expires_at = Instant::now() + Duration::from_secs(start.expires_in.unwrap_or(600).max(60));
    while Instant::now() < expires_at {
        sleep(Duration::from_millis(interval_ms)).await;
        let url = client.endpoint("/auth/device/poll")?;
        let response = client
            .http
            .post(url)
            .header(ACCEPT, "application/json")
            .json(&json!({ "id": start.id }))
            .send()
            .await
            .map_err(|error| ApiError::connection(&client.base_url, error))?;
        let status = response.status();
        let body = response.json::<DevicePoll>().await.unwrap_or_default();
        if status == StatusCode::ACCEPTED {
            interval_ms = body
                .interval
                .or(start.interval)
                .unwrap_or(5)
                .saturating_mul(1000)
                .max(LOGIN_POLL_FLOOR_MS);
            continue;
        }
        if !status.is_success() {
            bail!(
                "{}",
                body.error
                    .unwrap_or_else(|| format!("Device login failed with HTTP {status}"))
            );
        }
        let token = body.session_token.clone().ok_or_else(|| {
            anyhow!(
                "Device login succeeded, but {} did not return a terminal session token. Deploy the controller change first, or run against a local server started from this checkout.",
                controller_key(&client.base_url)
            )
        })?;
        client.token = Some(token);
        store_session(config, &client.base_url, &body, config_path)?;
        let user = body
            .user
            .as_ref()
            .and_then(|value| value.get("email"))
            .and_then(Value::as_str)
            .unwrap_or("Google user");
        println!("Google login complete: {user}.");
        println!("Terminal session saved: {}", config_path.display());
        return Ok(());
    }
    bail!("Device login expired")
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CommandCenter {
    #[serde(default)]
    machines: Vec<Machine>,
    #[serde(default)]
    agents: Vec<Agent>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Machine {
    id: Option<String>,
    hostname: Option<String>,
    machine_id: Option<String>,
    owner_email: Option<String>,
    stale: Option<bool>,
    agent_count: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Agent {
    machine_id: Option<String>,
    machine_raw_id: Option<String>,
    machine_hostname: Option<String>,
    machine_owner_id: Option<String>,
    machine_mux: Option<String>,
    mux: Option<String>,
    kind: Option<String>,
    status: Option<String>,
    cwd: Option<String>,
    last_user_text: Option<String>,
    last_user_at: Option<String>,
    last_assistant_text: Option<String>,
    last_assistant_at: Option<String>,
    last_activity_at: Option<String>,
    turn_count: Option<u64>,
    agent_session_id: Option<String>,
    window_id: Option<String>,
    pane_id: Option<String>,
    session_name: Option<String>,
    window_name: Option<String>,
    window_index: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WindowView {
    active_pane_id: Option<String>,
    #[serde(default)]
    panes: Vec<Pane>,
    capture: Option<Capture>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Pane {
    id: Option<String>,
    command: Option<String>,
    cwd: Option<String>,
    active: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct Capture {
    text: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct TranscriptResponse {
    result: Option<AgentTranscript>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AgentTranscript {
    kind: Option<String>,
    session_id: Option<String>,
    transcript_path: Option<String>,
    #[serde(default)]
    turns: Vec<TranscriptTurn>,
    turns_total: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct TranscriptTurn {
    role: Option<String>,
    text: Option<String>,
    t: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ViewMode {
    Dashboard,
    Detail,
    Conversations,
    Transcript,
    Machines,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputMode {
    Interact,
    Search,
}

struct TuiApp {
    api: ApiClient,
    runtime: RuntimeInfo,
    machines: Vec<Machine>,
    all_agents: Vec<Agent>,
    agents: Vec<Agent>,
    selected: usize,
    first_row: usize,
    grid_columns: usize,
    machine_filter: Option<String>,
    search_filter: String,
    machine_selected: usize,
    status: String,
    error: Option<String>,
    last_refresh: Instant,
    refresh_every: Duration,
    mode: ViewMode,
    detail: Option<WindowView>,
    detail_scroll: u16,
    transcript: Option<AgentTranscript>,
    transcript_scroll: u16,
    input_mode: Option<InputMode>,
    input: String,
    lines: u16,
    starred: HashSet<String>,
    config_path: PathBuf,
    show_help: bool,
    should_quit: bool,
}

impl TuiApp {
    fn new(
        api: ApiClient,
        runtime: RuntimeInfo,
        args: &Args,
        starred: HashSet<String>,
        config_path: PathBuf,
    ) -> Self {
        Self {
            api,
            runtime,
            machines: Vec::new(),
            all_agents: Vec::new(),
            agents: Vec::new(),
            selected: 0,
            first_row: 0,
            grid_columns: 1,
            machine_filter: None,
            search_filter: String::new(),
            machine_selected: 0,
            status: "Loading cards...".to_string(),
            error: None,
            last_refresh: Instant::now() - Duration::from_secs(60),
            refresh_every: Duration::from_millis(args.refresh_ms),
            mode: ViewMode::Dashboard,
            detail: None,
            detail_scroll: 0,
            transcript: None,
            transcript_scroll: 0,
            input_mode: None,
            input: String::new(),
            lines: args.lines,
            starred,
            config_path,
            show_help: false,
            should_quit: false,
        }
    }

    async fn refresh(&mut self) {
        let keep_key = self.selected_agent().map(card_key);
        match self
            .api
            .request_json::<CommandCenter>(Method::GET, "/api/command-center", None, None)
            .await
        {
            Ok(mut data) => {
                // Match the web Command Center's default order: starred cards
                // first, then most-recent activity (newest first).
                let starred = &self.starred;
                data.agents.sort_by(|a, b| starred_then_recent_cmp(starred, a, b));
                self.machines = data.machines;
                self.all_agents = data.agents;
                self.drop_missing_machine_filter();
                self.apply_filters(keep_key.as_deref());
                self.status = self.status_line();
                self.error = None;
            }
            Err(error) => {
                self.error = Some(error.message);
            }
        }
        self.last_refresh = Instant::now();
        self.keep_selected_visible();
    }

    fn selected_agent(&self) -> Option<&Agent> {
        self.agents.get(self.selected)
    }

    fn apply_filters(&mut self, keep_key: Option<&str>) {
        self.agents = self
            .all_agents
            .iter()
            .filter(|agent| self.machine_filter_matches(agent))
            .filter(|agent| self.search_filter_matches(agent))
            .cloned()
            .collect();
        if let Some(key) = keep_key {
            if let Some(index) = self.agents.iter().position(|agent| card_key(agent) == key) {
                self.selected = index;
            }
        }
        if self.selected >= self.agents.len() {
            self.selected = self.agents.len().saturating_sub(1);
        }
        self.first_row = 0;
    }

    fn machine_filter_matches(&self, agent: &Agent) -> bool {
        let Some(filter) = self.machine_filter.as_deref() else {
            return true;
        };
        let agent_key = agent_machine_key(agent);
        agent_key == filter
            || agent.machine_hostname.as_deref() == Some(filter)
            || self
                .machines
                .iter()
                .find(|machine| machine_key(machine) == filter)
                .is_some_and(|machine| {
                    agent_key == machine_key(machine)
                        || agent.machine_hostname.as_deref() == machine_label(machine)
                })
    }

    fn search_filter_matches(&self, agent: &Agent) -> bool {
        let query = self.search_filter.trim().to_ascii_lowercase();
        if query.is_empty() {
            return true;
        }
        let haystack = agent_haystack(agent);
        query.split_whitespace().all(|term| haystack.contains(term))
    }

    fn drop_missing_machine_filter(&mut self) {
        let Some(filter) = self.machine_filter.as_deref() else {
            return;
        };
        if !self
            .machines
            .iter()
            .any(|machine| machine_key(machine) == filter)
        {
            self.machine_filter = None;
            self.machine_selected = 0;
        }
    }

    fn status_line(&self) -> String {
        let mut parts = vec![format!(
            "{} of {} conversation{}",
            self.agents.len(),
            self.all_agents.len(),
            plural(self.all_agents.len())
        )];
        if let Some(filter) = self.machine_filter.as_deref() {
            let label = self
                .machines
                .iter()
                .find(|machine| machine_key(machine) == filter)
                .and_then(machine_label)
                .unwrap_or(filter);
            parts.push(format!("machine: {label}"));
        }
        if !self.search_filter.trim().is_empty() {
            parts.push(format!("filter: {}", self.search_filter.trim()));
        }
        parts.join(" · ")
    }

    fn keep_selected_visible(&mut self) {
        let row = if self.grid_columns == 0 {
            0
        } else {
            self.selected / self.grid_columns
        };
        if row < self.first_row {
            self.first_row = row;
        }
    }

    fn move_selection(&mut self, delta: isize) {
        if self.agents.is_empty() {
            self.selected = 0;
            return;
        }
        let max = self.agents.len() as isize - 1;
        self.selected = (self.selected as isize + delta).clamp(0, max) as usize;
        self.keep_selected_visible();
    }

    // Star/unstar the selected card, persist it, and re-sort so it jumps to (or
    // leaves) the starred group — keeping the same card selected.
    fn toggle_star(&mut self) {
        let Some(key) = self.selected_agent().map(card_key) else {
            self.error = Some("No conversation selected.".to_string());
            return;
        };
        let starred = if self.starred.remove(&key) {
            false
        } else {
            self.starred.insert(key.clone());
            true
        };
        self.all_agents
            .sort_by(|a, b| starred_then_recent_cmp(&self.starred, a, b));
        self.apply_filters(Some(&key));
        self.keep_selected_visible();
        self.status = if starred {
            "Starred card.".to_string()
        } else {
            "Removed star.".to_string()
        };
        if let Err(error) = self.persist_starred() {
            self.error = Some(format!("Could not save stars: {error}"));
        }
    }

    fn persist_starred(&self) -> Result<()> {
        let mut config = load_config(&self.config_path)?;
        let mut keys: Vec<String> = self.starred.iter().cloned().collect();
        keys.sort();
        config.starred = keys;
        save_config(&self.config_path, &config)
    }

    async fn open_detail(&mut self) {
        let Some(agent) = self.selected_agent().cloned() else {
            self.error = Some("No agent card selected.".to_string());
            return;
        };
        let Some(window_id) = agent.window_id.as_deref().filter(|s| !s.is_empty()) else {
            self.error = Some("Selected agent has no window id.".to_string());
            return;
        };
        let machine_id = agent_machine_key(&agent);
        let path = format!("/api/window-view?windowId={window_id}&lines={}", self.lines);
        match self
            .api
            .request_json::<WindowView>(Method::GET, &path, Some(&machine_id), None)
            .await
        {
            Ok(view) => {
                self.detail = Some(view);
                self.detail_scroll = 0;
                self.mode = ViewMode::Detail;
                self.error = None;
            }
            Err(error) => self.error = Some(error.message),
        }
    }

    async fn open_transcript(&mut self) {
        let Some(agent) = self.selected_agent().cloned() else {
            self.error = Some("No conversation selected.".to_string());
            return;
        };
        let Some(pane_id) = agent.pane_id.as_deref().filter(|s| !s.is_empty()) else {
            self.error = Some("Selected conversation has no pane id.".to_string());
            return;
        };
        let machine_id = agent_machine_key(&agent);
        let path = format!("/api/agent-transcript?paneId={pane_id}");
        match self
            .api
            .request_json::<TranscriptResponse>(Method::GET, &path, Some(&machine_id), None)
            .await
        {
            Ok(response) => {
                self.transcript = response.result;
                self.transcript_scroll = 0;
                self.mode = ViewMode::Transcript;
                self.error = None;
            }
            Err(error) => self.error = Some(error.message),
        }
    }

    fn begin_interact(&mut self) {
        if self.selected_agent().is_none() {
            self.error = Some("No conversation selected.".to_string());
            return;
        }
        self.input_mode = Some(InputMode::Interact);
        self.input.clear();
        self.error = None;
    }

    fn begin_search(&mut self) {
        self.input_mode = Some(InputMode::Search);
        self.input = self.search_filter.clone();
        self.error = None;
    }

    fn apply_search_input(&mut self) {
        self.search_filter = self.input.trim().to_string();
        self.input.clear();
        self.input_mode = None;
        self.apply_filters(None);
        self.status = self.status_line();
    }

    fn open_machine_picker(&mut self) {
        self.mode = ViewMode::Machines;
        self.machine_selected = self
            .machine_filter
            .as_deref()
            .and_then(|filter| {
                self.machines
                    .iter()
                    .position(|machine| machine_key(machine) == filter)
                    .map(|index| index + 1)
            })
            .unwrap_or(0);
        self.error = None;
    }

    fn move_machine_selection(&mut self, delta: isize) {
        let max = self.machines.len() as isize;
        self.machine_selected = (self.machine_selected as isize + delta).clamp(0, max) as usize;
    }

    fn apply_machine_selection(&mut self) {
        self.machine_filter = if self.machine_selected == 0 {
            None
        } else {
            self.machines
                .get(self.machine_selected - 1)
                .map(machine_key)
        };
        self.mode = ViewMode::Dashboard;
        self.apply_filters(None);
        self.status = self.status_line();
    }

    async fn send_input(&mut self) {
        let text = self.input.trim_end().to_string();
        self.input.clear();
        self.input_mode = None;
        if text.trim().is_empty() {
            return;
        }
        let Some(agent) = self.selected_agent().cloned() else {
            self.error = Some("No agent card selected.".to_string());
            return;
        };
        let Some(pane_id) = agent.pane_id.as_deref().filter(|s| !s.is_empty()) else {
            self.error = Some("Selected agent has no active pane id.".to_string());
            return;
        };
        let machine_id = agent_machine_key(&agent);
        let body = json!({ "paneId": pane_id, "text": text, "enter": true });
        match self
            .api
            .request_json::<Value>(Method::POST, "/api/send", Some(&machine_id), Some(body))
            .await
        {
            Ok(_) => {
                self.status = "Sent input to selected agent.".to_string();
                self.error = None;
                sleep(Duration::from_millis(300)).await;
                if self.mode == ViewMode::Detail {
                    self.open_detail().await;
                }
                self.refresh().await;
            }
            Err(error) => self.error = Some(error.message),
        }
    }

    async fn handle_key(&mut self, key: KeyEvent) {
        if key.kind != KeyEventKind::Press {
            return;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.should_quit = true;
            return;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('r') {
            self.refresh().await;
            return;
        }
        if self.show_help {
            // Any key dismisses the shortcut overlay.
            self.show_help = false;
            return;
        }
        if key.code == KeyCode::Char('?') {
            self.show_help = true;
            return;
        }
        if let Some(input_mode) = self.input_mode {
            match key.code {
                KeyCode::Esc => {
                    self.input_mode = None;
                    self.input.clear();
                }
                KeyCode::Enter => match input_mode {
                    InputMode::Interact => self.send_input().await,
                    InputMode::Search => self.apply_search_input(),
                },
                KeyCode::Backspace => {
                    self.input.pop();
                }
                KeyCode::Char(ch) => self.input.push(ch),
                _ => {}
            }
            return;
        }
        match key.code {
            KeyCode::Char('q') => self.should_quit = true,
            KeyCode::Char('u') => self.refresh().await,
            KeyCode::Char('s') => self.toggle_star(),
            KeyCode::Char('r') | KeyCode::Char('R') | KeyCode::Char('i') => self.begin_interact(),
            KeyCode::Char('/') => self.begin_search(),
            KeyCode::Char('d') => {
                toggle_theme();
                self.status = format!("Theme: {}", theme_name());
            }
            KeyCode::Char('m') => self.open_machine_picker(),
            KeyCode::Char('c') => {
                self.mode = ViewMode::Conversations;
                self.detail = None;
                self.transcript = None;
            }
            KeyCode::Char('t') => self.open_transcript().await,
            KeyCode::Enter if self.mode == ViewMode::Machines => self.apply_machine_selection(),
            KeyCode::Enter | KeyCode::Char('o') => self.open_detail().await,
            KeyCode::Esc if self.mode != ViewMode::Dashboard => {
                self.mode = ViewMode::Dashboard;
                self.detail = None;
                self.detail_scroll = 0;
                self.transcript = None;
                self.transcript_scroll = 0;
            }
            KeyCode::Down | KeyCode::Char('j') => match self.mode {
                ViewMode::Detail => self.detail_scroll = self.detail_scroll.saturating_add(1),
                ViewMode::Transcript => {
                    self.transcript_scroll = self.transcript_scroll.saturating_add(1)
                }
                ViewMode::Machines => self.move_machine_selection(1),
                // Grid is row-major: down moves a whole row; the list moves one item.
                ViewMode::Dashboard => self.move_selection(self.grid_columns as isize),
                _ => self.move_selection(1),
            },
            KeyCode::Up | KeyCode::Char('k') => match self.mode {
                ViewMode::Detail => self.detail_scroll = self.detail_scroll.saturating_sub(1),
                ViewMode::Transcript => {
                    self.transcript_scroll = self.transcript_scroll.saturating_sub(1)
                }
                ViewMode::Machines => self.move_machine_selection(-1),
                ViewMode::Dashboard => self.move_selection(-(self.grid_columns as isize)),
                _ => self.move_selection(-1),
            },
            KeyCode::Right | KeyCode::Char('l') => {
                if self.mode == ViewMode::Dashboard {
                    self.move_selection(1);
                }
            }
            KeyCode::Left | KeyCode::Char('h') => {
                if self.mode == ViewMode::Dashboard {
                    self.move_selection(-1);
                }
            }
            KeyCode::PageDown if self.mode == ViewMode::Detail => {
                self.detail_scroll = self.detail_scroll.saturating_add(12);
            }
            KeyCode::PageUp if self.mode == ViewMode::Detail => {
                self.detail_scroll = self.detail_scroll.saturating_sub(12);
            }
            KeyCode::PageDown if self.mode == ViewMode::Transcript => {
                self.transcript_scroll = self.transcript_scroll.saturating_add(12);
            }
            KeyCode::PageUp if self.mode == ViewMode::Transcript => {
                self.transcript_scroll = self.transcript_scroll.saturating_sub(12);
            }
            _ => {}
        }
    }

    async fn run(&mut self, terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> Result<()> {
        self.refresh().await;
        while !self.should_quit {
            terminal.draw(|frame| self.render(frame))?;
            if event::poll(Duration::from_millis(80))? {
                if let Event::Key(key) = event::read()? {
                    self.handle_key(key).await;
                }
            }
            if Instant::now().duration_since(self.last_refresh) >= self.refresh_every {
                self.refresh().await;
            }
        }
        Ok(())
    }

    fn render(&mut self, frame: &mut Frame<'_>) {
        let area = frame.area();
        let footer_height = if self.input_mode.is_some() { 4 } else { 2 };
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Min(8),
                Constraint::Length(footer_height),
            ])
            .split(area);
        self.render_header(frame, chunks[0]);
        match self.mode {
            ViewMode::Dashboard => self.render_dashboard(frame, chunks[1]),
            ViewMode::Detail => self.render_detail(frame, chunks[1]),
            ViewMode::Conversations => self.render_conversation_list(frame, chunks[1]),
            ViewMode::Transcript => self.render_transcript(frame, chunks[1]),
            ViewMode::Machines => self.render_machine_picker(frame, chunks[1]),
        }
        self.render_footer(frame, chunks[2]);
        if self.show_help {
            self.render_help(frame, area);
        }
    }

    fn render_help(&self, frame: &mut Frame<'_>, area: Rect) {
        let rows: &[(&str, &str)] = &[
            ("↑↓ / j k", "Up / down a row"),
            ("← → / h l", "Left / right a column"),
            ("Enter / o", "Open pane detail"),
            ("s", "Star / unstar card"),
            ("r / i", "Interact (send input)"),
            ("t", "Open transcript"),
            ("c", "Conversation list"),
            ("m", "Machine filter"),
            ("/", "Filter conversations"),
            ("PgUp/PgDn", "Scroll detail / transcript"),
            ("u / Ctrl-R", "Refresh now"),
            ("d", "Toggle theme"),
            ("Esc", "Back to cards"),
            ("?", "Toggle this help"),
            ("q / Ctrl-C", "Quit"),
        ];
        let mut lines: Vec<Line> = Vec::with_capacity(rows.len());
        for (keys, desc) in rows {
            lines.push(Line::from(vec![
                Span::styled(
                    format!("{keys:>12}  "),
                    Style::default().fg(blue()).add_modifier(Modifier::BOLD),
                ),
                Span::styled((*desc).to_string(), Style::default().fg(ink())),
            ]));
        }
        let width = 46.min(area.width.saturating_sub(2)).max(20);
        let height = (rows.len() as u16 + 2).min(area.height.saturating_sub(2)).max(3);
        let popup = Rect {
            x: area.x + (area.width.saturating_sub(width)) / 2,
            y: area.y + (area.height.saturating_sub(height)) / 2,
            width,
            height,
        };
        let help = Paragraph::new(Text::from(lines)).block(
            Block::default()
                .title(Line::from(Span::styled(
                    " Keyboard Shortcuts ",
                    Style::default().fg(ink()).add_modifier(Modifier::BOLD),
                )))
                .borders(Borders::ALL)
                .border_set(symbols::border::ROUNDED)
                .border_style(Style::default().fg(blue()))
                .style(Style::default().bg(surface())),
        );
        frame.render_widget(Clear, popup);
        frame.render_widget(help, popup);
    }

    fn render_header(&self, frame: &mut Frame<'_>, area: Rect) {
        let mode = self.runtime.mode.as_deref().unwrap_or("local");
        let mut lines = vec![Line::from(vec![
            Span::styled(
                "tmux-mobile",
                Style::default().fg(ink()).add_modifier(Modifier::BOLD),
            ),
            Span::raw("  "),
            Span::styled(
                "terminal cards",
                Style::default().fg(blue()).add_modifier(Modifier::BOLD),
            ),
            Span::raw("   "),
            Span::styled(mode, Style::default().fg(muted())),
        ])];
        let message = self.error.as_deref().unwrap_or(&self.status);
        lines.push(Line::from(Span::styled(
            message.to_string(),
            Style::default().fg(if self.error.is_some() { red() } else { muted() }),
        )));
        let header = Paragraph::new(Text::from(lines)).block(
            Block::default()
                .borders(Borders::ALL)
                .border_set(symbols::border::ROUNDED)
                .border_style(Style::default().fg(line()))
                .style(Style::default().bg(surface())),
        );
        frame.render_widget(header, area);
    }

    fn render_dashboard(&mut self, frame: &mut Frame<'_>, area: Rect) {
        if self.agents.is_empty() {
            let empty = Paragraph::new(Text::from(vec![
                Line::from(Span::styled(
                    "No Codex or Claude Code agent cards are visible right now.",
                    Style::default().fg(muted()),
                )),
                Line::from(Span::styled(
                    "Start an agent from the web Command Center or connect another machine.",
                    Style::default().fg(muted()),
                )),
            ]))
            .alignment(Alignment::Center)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_set(symbols::border::ROUNDED)
                    .border_style(Style::default().fg(line())),
            );
            frame.render_widget(empty, area);
            return;
        }

        let columns = (area.width / CARD_MIN_WIDTH).max(1) as usize;
        self.grid_columns = columns;
        let visible_rows = (area.height / CARD_HEIGHT).max(1) as usize;
        let selected_row = self.selected / columns;
        if selected_row < self.first_row {
            self.first_row = selected_row;
        } else if selected_row >= self.first_row + visible_rows {
            self.first_row = selected_row + 1 - visible_rows;
        }

        let row_constraints = vec![Constraint::Length(CARD_HEIGHT); visible_rows];
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints(row_constraints)
            .split(area);
        for (row_offset, row_area) in rows.iter().enumerate() {
            let row_index = self.first_row + row_offset;
            let first = row_index * columns;
            if first >= self.agents.len() {
                break;
            }
            let col_constraints = vec![Constraint::Ratio(1, columns as u32); columns];
            let cells = Layout::default()
                .direction(Direction::Horizontal)
                .constraints(col_constraints)
                .split(*row_area);
            for (col, cell) in cells.iter().enumerate() {
                let index = first + col;
                if let Some(agent) = self.agents.get(index) {
                    let starred = self.starred.contains(&card_key(agent));
                    render_card(frame, *cell, agent, index == self.selected, starred);
                }
            }
        }
    }

    fn render_detail(&self, frame: &mut Frame<'_>, area: Rect) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(10), Constraint::Min(4)])
            .split(area);
        if let Some(agent) = self.selected_agent() {
            let starred = self.starred.contains(&card_key(agent));
            render_card(frame, chunks[0], agent, true, starred);
        }
        let capture = self
            .detail
            .as_ref()
            .and_then(|detail| detail.capture.as_ref());
        let text = capture
            .and_then(|capture| {
                capture
                    .error
                    .as_ref()
                    .map(|error| format!("Capture failed: {error}"))
            })
            .or_else(|| capture.and_then(|capture| capture.text.clone()))
            .unwrap_or_else(|| "[no visible output]".to_string());
        let pane_title = self
            .detail
            .as_ref()
            .map(pane_title)
            .unwrap_or_else(|| "Pane".to_string());
        let pane = Paragraph::new(text)
            .scroll((self.detail_scroll, 0))
            .wrap(Wrap { trim: false })
            .block(
                Block::default()
                    .title(Line::from(Span::styled(
                        pane_title,
                        Style::default().fg(ink()).add_modifier(Modifier::BOLD),
                    )))
                    .borders(Borders::ALL)
                    .border_set(symbols::border::ROUNDED)
                    .border_style(Style::default().fg(blue())),
            );
        frame.render_widget(pane, chunks[1]);
    }

    fn render_conversation_list(&mut self, frame: &mut Frame<'_>, area: Rect) {
        let mut lines = Vec::new();
        if self.agents.is_empty() {
            lines.push(Line::from(Span::styled(
                "No conversations match the current filters.",
                Style::default().fg(muted()),
            )));
        }
        let height = area.height.saturating_sub(2) as usize;
        let selected = self.selected.min(self.agents.len().saturating_sub(1));
        let start = selected.saturating_sub(height.saturating_sub(1));
        for (index, agent) in self
            .agents
            .iter()
            .enumerate()
            .skip(start)
            .take(height.max(1))
        {
            let marker = if index == selected { ">" } else { " " };
            let status = normalized_status(agent.status.as_deref());
            let star = if self.starred.contains(&card_key(agent)) {
                "★ "
            } else {
                ""
            };
            let title = format!(
                "{} {}{}  {}  {}",
                marker,
                star,
                status_label(status),
                machine_label_from_agent(agent),
                title_for_agent(agent)
            );
            let style = if index == selected {
                Style::default().fg(blue()).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(ink())
            };
            lines.push(Line::from(Span::styled(title, style)));
            let prompt = clean_one_line(agent.last_user_text.as_deref().unwrap_or(""));
            if !prompt.is_empty() {
                lines.push(Line::from(Span::styled(
                    format!(
                        "    {}",
                        truncate(&prompt, area.width.saturating_sub(8) as usize)
                    ),
                    Style::default().fg(muted()),
                )));
            }
        }
        let list = Paragraph::new(Text::from(lines)).block(
            Block::default()
                .title(Line::from(Span::styled(
                    " Conversations ",
                    Style::default().fg(ink()).add_modifier(Modifier::BOLD),
                )))
                .borders(Borders::ALL)
                .border_set(symbols::border::ROUNDED)
                .border_style(Style::default().fg(line())),
        );
        frame.render_widget(list, area);
    }

    fn render_transcript(&self, frame: &mut Frame<'_>, area: Rect) {
        let title = self
            .selected_agent()
            .map(title_for_agent)
            .unwrap_or_else(|| "Conversation".to_string());
        let text = match &self.transcript {
            Some(transcript) if transcript.turns.is_empty() => {
                Text::from(vec![Line::from(Span::styled(
                    "Transcript located, but no user/assistant turns were parsed yet.",
                    Style::default().fg(muted()),
                ))])
            }
            Some(transcript) => transcript_text(transcript),
            None => Text::from(vec![Line::from(Span::styled(
                "No Codex or Claude transcript detected.",
                Style::default().fg(muted()),
            ))]),
        };
        let meta = self
            .transcript
            .as_ref()
            .map(|transcript| {
                let kind = kind_label(transcript.kind.as_deref());
                let shown = transcript.turns.len();
                let total = transcript.turns_total.unwrap_or(shown);
                let session = transcript
                    .session_id
                    .as_deref()
                    .map(|id| format!(" · session {}", &id[..id.len().min(8)]))
                    .unwrap_or_default();
                let path = transcript
                    .transcript_path
                    .as_deref()
                    .map(abbrev_home)
                    .map(|path| format!(" · {path}"))
                    .unwrap_or_default();
                format!(
                    "{kind} · {shown}/{total} turn{}{}{}",
                    plural(total),
                    session,
                    path
                )
            })
            .unwrap_or_else(|| "Transcript".to_string());
        let pane = Paragraph::new(text)
            .scroll((self.transcript_scroll, 0))
            .wrap(Wrap { trim: false })
            .block(
                Block::default()
                    .title(Line::from(vec![
                        Span::styled(
                            format!(" {title} "),
                            Style::default().fg(ink()).add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(meta, Style::default().fg(muted())),
                    ]))
                    .borders(Borders::ALL)
                    .border_set(symbols::border::ROUNDED)
                    .border_style(Style::default().fg(blue())),
            );
        frame.render_widget(pane, area);
    }

    fn render_machine_picker(&self, frame: &mut Frame<'_>, area: Rect) {
        let mut lines = Vec::new();
        let all_style = if self.machine_selected == 0 {
            Style::default().fg(blue()).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(ink())
        };
        lines.push(Line::from(Span::styled(
            format!(
                "{} All machines  {} conversation{}",
                if self.machine_selected == 0 { ">" } else { " " },
                self.all_agents.len(),
                plural(self.all_agents.len())
            ),
            all_style,
        )));
        for (index, machine) in self.machines.iter().enumerate() {
            let selected = self.machine_selected == index + 1;
            let key = machine_key(machine);
            let count = self
                .all_agents
                .iter()
                .filter(|agent| agent_machine_key(agent) == key)
                .count();
            let reported = machine.agent_count.unwrap_or(count as u64);
            let label = machine_label(machine).unwrap_or(&key);
            let owner = machine.owner_email.as_deref().unwrap_or("");
            let stale = if machine.stale.unwrap_or(false) {
                " stale"
            } else {
                ""
            };
            let style = if selected {
                Style::default().fg(blue()).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(ink())
            };
            lines.push(Line::from(Span::styled(
                format!(
                    "{} {}  {} conversation{}{}{}",
                    if selected { ">" } else { " " },
                    label,
                    reported,
                    plural(reported as usize),
                    if owner.is_empty() { "" } else { " · " },
                    owner
                ),
                style,
            )));
            if !stale.is_empty() {
                lines.push(Line::from(Span::styled(
                    format!("    {stale}"),
                    Style::default().fg(amber()),
                )));
            }
        }
        let picker = Paragraph::new(Text::from(lines)).block(
            Block::default()
                .title(Line::from(Span::styled(
                    " Machine Filter ",
                    Style::default().fg(ink()).add_modifier(Modifier::BOLD),
                )))
                .borders(Borders::ALL)
                .border_set(symbols::border::ROUNDED)
                .border_style(Style::default().fg(blue())),
        );
        frame.render_widget(picker, area);
    }

    fn render_footer(&self, frame: &mut Frame<'_>, area: Rect) {
        if let Some(input_mode) = self.input_mode {
            let target = self
                .selected_agent()
                .map(title_for_agent)
                .unwrap_or_else(|| "no selected agent".to_string());
            let title = match input_mode {
                InputMode::Interact => vec![
                    Span::styled("Interact with ", Style::default().fg(muted())),
                    Span::styled(
                        target,
                        Style::default().fg(ink()).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled("  Enter sends · Esc cancels", Style::default().fg(muted())),
                ],
                InputMode::Search => vec![
                    Span::styled("Filter conversations ", Style::default().fg(muted())),
                    Span::styled("Enter applies · Esc cancels", Style::default().fg(muted())),
                ],
            };
            let input = Paragraph::new(self.input.as_str())
                .wrap(Wrap { trim: false })
                .block(
                    Block::default()
                        .title(Line::from(title))
                        .borders(Borders::ALL)
                        .border_set(symbols::border::ROUNDED)
                        .border_style(Style::default().fg(blue())),
                );
            frame.render_widget(input, area);
            return;
        }
        let help = match self.mode {
            ViewMode::Dashboard => {
                "↑↓←→/hjkl select   s star   r interact   t transcript   c list   m machine   / filter   ? help   q quit"
            }
            ViewMode::Detail => {
                "↑↓ scroll   s star   r interact   t transcript   d theme   u refresh   ? help   Esc cards   q quit"
            }
            ViewMode::Conversations => {
                "↑↓/jk select   Enter open pane   s star   r interact   t transcript   m machine   / filter   ? help   Esc cards"
            }
            ViewMode::Transcript => {
                "↑↓ scroll   PageUp/PageDown   r interact   d theme   ? help   Esc cards   q quit"
            }
            ViewMode::Machines => {
                "↑↓/jk select machine   Enter apply filter   d theme   ? help   Esc cards   q quit"
            }
        };
        let footer = Paragraph::new(Line::from(Span::styled(help, Style::default().fg(muted()))))
            .alignment(Alignment::Center)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_set(symbols::border::ROUNDED)
                    .border_style(Style::default().fg(line())),
            );
        frame.render_widget(footer, area);
    }
}

fn render_card(frame: &mut Frame<'_>, area: Rect, agent: &Agent, selected: bool, starred: bool) {
    if area.width < 8 || area.height < 6 {
        return;
    }
    let status = normalized_status(agent.status.as_deref());
    let border_color = if selected {
        blue()
    } else {
        status_color(status)
    };
    let mut title_spans = vec![
        Span::styled(" ", Style::default().bg(surface())),
        Span::styled(
            status_label(status),
            Style::default()
                .fg(status_color(status))
                .bg(surface())
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(" ", Style::default().bg(surface())),
    ];
    if starred {
        title_spans.push(Span::styled(
            "★ ",
            Style::default().fg(amber()).bg(surface()),
        ));
    }
    let mut block = Block::default()
        .borders(Borders::ALL)
        .border_set(symbols::border::ROUNDED)
        .border_style(Style::default().fg(border_color))
        .style(Style::default().bg(surface()))
        .title(Line::from(title_spans));
    if selected {
        block = block.title_bottom(Line::from(Span::styled(
            " selected ",
            Style::default().fg(blue()).add_modifier(Modifier::BOLD),
        )));
    }

    let width = area.width.saturating_sub(4) as usize;
    let title = title_for_agent(agent);
    let mut lines = vec![
        Line::from(vec![
            Span::styled(
                truncate(&title, width.saturating_sub(5)),
                Style::default().fg(ink()).add_modifier(Modifier::BOLD),
            ),
            Span::raw(" "),
            Span::styled(window_index(agent), Style::default().fg(muted())),
        ]),
        chips_line(agent),
        Line::from(Span::styled(
            truncate(&abbrev_home(agent.cwd.as_deref().unwrap_or("")), width),
            Style::default().fg(muted()),
        )),
        section_label("LAST PROMPT", agent.last_user_at.as_deref()),
    ];
    lines.extend(excerpt_lines(
        agent.last_user_text.as_deref(),
        width,
        2,
        Style::default().fg(ink()).bg(surface_soft()),
    ));
    lines.push(section_label(
        "LAST RESPONSE",
        agent.last_assistant_at.as_deref(),
    ));
    lines.extend(excerpt_lines(
        agent.last_assistant_text.as_deref(),
        width,
        3,
        Style::default().fg(ink()),
    ));
    lines.push(Line::from(vec![
        Span::styled(
            format!(
                "{} turn{}",
                agent.turn_count.unwrap_or(0),
                plural(agent.turn_count.unwrap_or(0) as usize)
            ),
            Style::default().fg(muted()),
        ),
        Span::raw("  "),
        Span::styled(
            session_short(agent),
            Style::default().fg(muted()).add_modifier(Modifier::ITALIC),
        ),
    ]));

    frame.render_widget(Paragraph::new(Text::from(lines)).block(block), area);
}

fn chips_line(agent: &Agent) -> Line<'static> {
    let mut spans = Vec::new();
    let machine = machine_label_from_agent(agent);
    if !machine.is_empty() {
        spans.extend(chip(&machine, muted(), surface_soft()));
    }
    if let Some(owner) = agent.machine_owner_id.as_deref().filter(|s| !s.is_empty()) {
        let local = owner.split('@').next().unwrap_or(owner);
        spans.extend(chip(local, muted(), surface_soft()));
    }
    spans.extend(chip(&mux_label(agent), green(), surface_soft()));
    let kind = kind_label(agent.kind.as_deref());
    spans.extend(chip(
        &kind,
        kind_color(agent.kind.as_deref()),
        surface_soft(),
    ));
    Line::from(spans)
}

fn chip(label: &str, fg: Color, bg: Color) -> Vec<Span<'static>> {
    vec![
        Span::raw(" "),
        Span::styled(
            format!(" {label} "),
            Style::default().fg(fg).bg(bg).add_modifier(Modifier::BOLD),
        ),
    ]
}

fn section_label(label: &str, timestamp: Option<&str>) -> Line<'static> {
    let mut spans = vec![Span::styled(
        label.to_string(),
        Style::default().fg(muted()).add_modifier(Modifier::BOLD),
    )];
    if let Some(relative) = timestamp.and_then(relative_time_label) {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(relative, Style::default().fg(muted())));
    }
    Line::from(spans)
}

fn excerpt_lines(
    text: Option<&str>,
    width: usize,
    limit: usize,
    style: Style,
) -> Vec<Line<'static>> {
    let text = text.unwrap_or("").trim();
    if text.is_empty() {
        return vec![Line::from(Span::styled(
            "(empty)",
            Style::default().fg(muted()),
        ))];
    }
    let cleaned = text.replace('\r', "").replace('\t', "  ");
    let width = width.max(8);
    let mut lines: Vec<String> = textwrap::wrap(&cleaned, width)
        .into_iter()
        .take(limit)
        .map(|line| line.into_owned())
        .collect();
    if textwrap::wrap(&cleaned, width).len() > limit {
        if let Some(last) = lines.last_mut() {
            *last = format!("{}…", last.trim_end_matches('.'));
        }
    }
    lines
        .into_iter()
        .map(|line| Line::from(Span::styled(line, style)))
        .collect()
}

fn machine_key(machine: &Machine) -> String {
    machine
        .id
        .as_deref()
        .or(machine.machine_id.as_deref())
        .or(machine.hostname.as_deref())
        .unwrap_or("local")
        .to_string()
}

fn machine_label(machine: &Machine) -> Option<&str> {
    machine
        .hostname
        .as_deref()
        .or(machine.machine_id.as_deref())
        .or(machine.id.as_deref())
}

fn clean_one_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn agent_haystack(agent: &Agent) -> String {
    [
        agent.machine_hostname.as_deref(),
        agent.machine_id.as_deref(),
        agent.machine_raw_id.as_deref(),
        agent.session_name.as_deref(),
        agent.window_name.as_deref(),
        agent.window_id.as_deref(),
        agent.pane_id.as_deref(),
        agent.kind.as_deref(),
        agent.cwd.as_deref(),
        agent.last_user_text.as_deref(),
        agent.last_assistant_text.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
    .to_ascii_lowercase()
}

fn transcript_text(transcript: &AgentTranscript) -> Text<'static> {
    let mut lines = Vec::new();
    for (index, turn) in transcript.turns.iter().enumerate() {
        let role = match turn.role.as_deref() {
            Some("assistant") => "Agent response",
            _ => "User prompt",
        };
        let color = if turn.role.as_deref() == Some("assistant") {
            blue()
        } else {
            green()
        };
        let mut header = vec![Span::styled(
            format!("{role} {}", index + 1),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        )];
        if let Some(relative) = turn.t.as_deref().and_then(relative_time_label) {
            header.push(Span::raw("  "));
            header.push(Span::styled(relative, Style::default().fg(muted())));
        }
        lines.push(Line::from(header));
        let text = turn.text.as_deref().unwrap_or("").trim();
        if text.is_empty() {
            lines.push(Line::from(Span::styled(
                "(empty)",
                Style::default().fg(muted()),
            )));
        } else {
            for raw in text.lines() {
                lines.push(Line::from(Span::styled(
                    raw.to_string(),
                    Style::default().fg(ink()),
                )));
            }
        }
        lines.push(Line::from(""));
    }
    Text::from(lines)
}

fn pane_title(detail: &WindowView) -> String {
    let active_id = detail
        .active_pane_id
        .as_deref()
        .or_else(|| {
            detail
                .panes
                .iter()
                .find(|pane| pane.active.unwrap_or(false))
                .and_then(|pane| pane.id.as_deref())
        })
        .unwrap_or("pane");
    let pane = detail
        .panes
        .iter()
        .find(|pane| pane.id.as_deref() == Some(active_id));
    let mut parts = vec![active_id.to_string()];
    if let Some(command) = pane.and_then(|pane| pane.command.as_deref()) {
        parts.push(command.to_string());
    }
    if let Some(cwd) = pane.and_then(|pane| pane.cwd.as_deref()) {
        parts.push(abbrev_home(cwd));
    }
    parts.join(" | ")
}

fn normalize_base_url(input: &str) -> Result<Url> {
    let mut value = input.trim().to_string();
    if value.is_empty() {
        value = DEFAULT_URL.to_string();
    }
    if !value.contains("://") {
        let lower = value.to_ascii_lowercase();
        let local = lower.starts_with("localhost")
            || lower.starts_with("127.0.0.1")
            || lower.starts_with("[::1]")
            || lower.starts_with("0.0.0.0");
        value = format!("{}://{value}", if local { "http" } else { "https" });
    }
    let mut url = Url::parse(&value).with_context(|| format!("invalid URL: {value}"))?;
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn controller_key(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    format!("{}://{host}{port}", url.scheme())
}

fn clamp_lines(value: u16) -> u16 {
    value.clamp(10, 5000)
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

// Web Command Center default order: starred cards first, then most-recent
// activity (newest first), with a stable label tiebreak so equal timestamps
// don't shuffle between refreshes.
fn starred_then_recent_cmp(starred: &HashSet<String>, a: &Agent, b: &Agent) -> std::cmp::Ordering {
    let sa = starred.contains(&card_key(a));
    let sb = starred.contains(&card_key(b));
    sb.cmp(&sa)
        .then_with(|| activity_ms(b).cmp(&activity_ms(a)))
        .then_with(|| machine_label_from_agent(a).cmp(&machine_label_from_agent(b)))
        .then_with(|| title_for_agent(a).cmp(&title_for_agent(b)))
}

// Epoch milliseconds of the agent's most recent activity; 0 (sorts last) when
// the transcript carries no per-turn timestamp.
fn activity_ms(agent: &Agent) -> i64 {
    agent
        .last_activity_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

fn normalized_status(status: Option<&str>) -> &'static str {
    match status.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "waiting" => "waiting",
        "running" => "running",
        "idle" => "idle",
        _ => "unverified",
    }
}

fn status_label(status: &str) -> &'static str {
    match status {
        "waiting" => "Needs input",
        "running" => "Working",
        "idle" => "Idle",
        _ => "Unknown",
    }
}

fn status_color(status: &str) -> Color {
    match status {
        "waiting" => red(),
        "running" => blue(),
        "idle" => line(),
        _ => amber(),
    }
}

fn agent_machine_key(agent: &Agent) -> String {
    agent
        .machine_id
        .as_deref()
        .or(agent.machine_raw_id.as_deref())
        .or(agent.machine_hostname.as_deref())
        .unwrap_or("local")
        .to_string()
}

fn machine_label_from_agent(agent: &Agent) -> String {
    agent
        .machine_hostname
        .as_deref()
        .or(agent.machine_id.as_deref())
        .unwrap_or("")
        .to_string()
}

fn title_for_agent(agent: &Agent) -> String {
    let session = agent.session_name.as_deref().unwrap_or("?");
    let window = agent.window_name.as_deref().unwrap_or("(unnamed)");
    format!("{session} · {window}")
}

fn card_key(agent: &Agent) -> String {
    format!(
        "{}::{}::{}",
        agent_machine_key(agent),
        agent
            .mux
            .as_deref()
            .or(agent.machine_mux.as_deref())
            .unwrap_or("tmux"),
        agent
            .window_id
            .as_deref()
            .or(agent.pane_id.as_deref())
            .or(agent.agent_session_id.as_deref())
            .unwrap_or("")
    )
}

fn window_index(agent: &Agent) -> String {
    agent
        .window_index
        .map(|index| format!("#{index}"))
        .unwrap_or_default()
}

fn session_short(agent: &Agent) -> String {
    let id = agent.agent_session_id.as_deref().unwrap_or("");
    if id.is_empty() {
        "session -".to_string()
    } else {
        format!("session {}", &id[..id.len().min(8)])
    }
}

fn mux_label(agent: &Agent) -> String {
    let mux = agent
        .mux
        .as_deref()
        .or(agent.machine_mux.as_deref())
        .unwrap_or("tmux")
        .trim()
        .to_ascii_lowercase();
    if mux == "rmux" {
        "RMUX".to_string()
    } else {
        "TMUX".to_string()
    }
}

fn kind_label(kind: Option<&str>) -> String {
    match kind.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "codex" => "Codex".to_string(),
        "claude" | "claude-code" | "claude code" | "cc" => "Claude".to_string(),
        other if !other.is_empty() => other.to_string(),
        _ => "Agent".to_string(),
    }
}

fn kind_color(kind: Option<&str>) -> Color {
    match kind.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "codex" => Color::Rgb(47, 91, 183),
        "claude" | "claude-code" | "claude code" | "cc" => Color::Rgb(181, 83, 15),
        _ => muted(),
    }
}

fn abbrev_home(value: &str) -> String {
    let Ok(home) = env::var("HOME") else {
        return value.to_string();
    };
    if value == home {
        return "~".to_string();
    }
    if let Some(rest) = value.strip_prefix(&(home + "/")) {
        return format!("~/{rest}");
    }
    value
        .strip_prefix("/root")
        .map(|rest| format!("~{rest}"))
        .unwrap_or_else(|| value.to_string())
}

fn relative_time_label(value: &str) -> Option<String> {
    let then = DateTime::parse_from_rfc3339(value)
        .ok()?
        .with_timezone(&Utc);
    let diff = Utc::now() - then;
    let seconds = diff.num_seconds();
    if seconds < -45 {
        return Some("soon".to_string());
    }
    if seconds < 45 {
        return Some("now".to_string());
    }
    for (label, size) in [("d", 86_400), ("h", 3_600), ("m", 60)] {
        if seconds >= size {
            return Some(format!("{}{} ago", seconds / size, label));
        }
    }
    Some("1m ago".to_string())
}

fn truncate(value: &str, width: usize) -> String {
    if value.chars().count() <= width {
        return value.to_string();
    }
    if width <= 1 {
        return "…".to_string();
    }
    let mut output = value.chars().take(width - 1).collect::<String>();
    output.push('…');
    output
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse()?;
    if args.help {
        usage();
        return Ok(());
    }
    set_theme(args.theme);

    let base_url = normalize_base_url(&args.url)?;
    let config_path = config_path()?;
    let mut config = load_config(&config_path)?;
    let mut client = ApiClient::new(base_url, args.token.clone());
    let runtime = ensure_runtime(&mut client, &mut config, &config_path, &args).await?;
    let starred: HashSet<String> = config.starred.iter().cloned().collect();

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let mut app = TuiApp::new(client, runtime, &args, starred, config_path);
    let result = app.run(&mut terminal).await;
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    result
}
