use anyhow::{anyhow, Context, Result};
use oauth2::reqwest::async_http_client;
use oauth2::{
    basic::BasicClient, AuthUrl, AuthorizationCode, ClientId, ClientSecret,
    RedirectUrl, Scope, TokenResponse, TokenUrl,
};
use std::net::TcpListener;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

fn find_open_port(start: u16, end: u16) -> Result<u16> {
    for port in start..=end {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    Err(anyhow!("No open ports in range {}-{}", start, end))
}

#[allow(deprecated)]
pub async fn start_consent_flow(
    app_handle: tauri::AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<()> {
    let port = find_open_port(7777, 7799)?;
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    let client = BasicClient::new(
        ClientId::new(client_id.clone()),
        Some(ClientSecret::new(client_secret.clone())),
        AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".into())?,
        Some(TokenUrl::new(
            "https://oauth2.googleapis.com/token".into(),
        )?),
    )
    .set_redirect_uri(RedirectUrl::new(redirect_uri.clone())?);

    let (auth_url, _csrf) = client
        .authorize_url(|| oauth2::CsrfToken::new_random())
        .add_scope(Scope::new("https://mail.google.com/".into()))
        .add_extra_param("access_type", "offline")
        .add_extra_param("prompt", "consent")
        .url();

    app_handle
        .shell()
        .open(auth_url.to_string(), None)
        .map_err(|e| anyhow!("failed to open browser: {}", e))?;

    let (tx, rx) = tokio::sync::oneshot::channel();

    let server_addr = format!("127.0.0.1:{}", port);
    tokio::task::spawn_blocking(move || {
        let server = match tiny_http::Server::http(&server_addr) {
            Ok(s) => s,
            Err(e) => {
                let _ = tx.send(Err(anyhow!("server start failed: {}", e)));
                return;
            }
        };

        let request = match server.recv() {
            Ok(req) => req,
            Err(e) => {
                let _ = tx.send(Err(anyhow!("server recv error: {}", e)));
                return;
            }
        };

        let code = parse_code(request.url());

        let response_body = match &code {
            Ok(_) => "<html><body style=\"font-family:sans-serif;text-align:center;padding-top:80px\"><h1>Connected!</h1><p>You may close this window and return to ClientHub.</p></body></html>",
            Err(e) => &format!("<html><body style=\"font-family:sans-serif;text-align:center;padding-top:80px\"><h1>Authorization Failed</h1><p>{}</p></body></html>", e),
        };

        let response = tiny_http::Response::from_string(response_body)
            .with_header(tiny_http::Header {
                field: "Content-Type".parse().unwrap(),
                value: "text/html".parse().unwrap(),
            });
        let _ = request.respond(response);

        let _ = tx.send(code);
    });

    let code = tokio::time::timeout(Duration::from_secs(60), rx)
        .await
        .map_err(|_| anyhow!("timed out waiting for authorization"))?
        .context("internal error")??;

    let token = client
        .exchange_code(AuthorizationCode::new(code))
        .request_async(async_http_client)
        .await
        .map_err(|e| anyhow!("token exchange failed: {}", e))?;

    let refresh = token
        .refresh_token()
        .ok_or_else(|| anyhow!("no refresh token returned — try again"))?
        .secret()
        .clone();

    crate::email::save_cred("oauth_client_id", &client_id)?;
    crate::email::save_cred("oauth_client_secret", &client_secret)?;
    crate::email::save_cred("oauth_refresh_token", &refresh)?;

    Ok(())
}

fn parse_code(url: &str) -> Result<String> {
    let path = url
        .split('?')
        .nth(1)
        .ok_or_else(|| anyhow!("no query string in callback"))?;

    let params: Vec<(&str, &str)> = path
        .split('&')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            Some((parts.next()?, parts.next().unwrap_or("")))
        })
        .collect();

    if let Some(error) = params
        .iter()
        .find(|(k, _)| *k == "error")
        .map(|(_, v)| v.to_string())
    {
        let desc = params
            .iter()
            .find(|(k, _)| *k == "error_description")
            .map(|(_, v)| v.to_string())
            .unwrap_or_default();
        return Err(anyhow!("authorization error: {} — {}", error, desc));
    }

    params
        .iter()
        .find(|(k, _)| *k == "code")
        .map(|(_, v)| v.to_string())
        .ok_or_else(|| anyhow!("no authorization code in callback"))
}
