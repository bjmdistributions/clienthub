use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct GoogleContact {
    pub resource_name: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub organization: Option<String>,
    pub street_address: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub zip_code: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PeopleResponse {
    #[serde(default)]
    connections: Vec<PersonConnection>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PersonConnection {
    #[serde(rename = "resourceName")]
    resource_name: String,
    #[serde(default)]
    names: Vec<PersonName>,
    #[serde(default)]
    #[serde(rename = "emailAddresses")]
    email_addresses: Vec<PersonEmail>,
    #[serde(default)]
    #[serde(rename = "phoneNumbers")]
    phone_numbers: Vec<PersonPhone>,
    #[serde(default)]
    organizations: Vec<PersonOrg>,
    #[serde(default)]
    addresses: Vec<PersonAddress>,
}

#[derive(Debug, Deserialize)]
struct PersonName {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PersonEmail {
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PersonPhone {
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PersonOrg {
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PersonAddress {
    #[serde(rename = "streetAddress")]
    street_address: Option<String>,
    city: Option<String>,
    region: Option<String>,
    #[serde(rename = "postalCode")]
    postal_code: Option<String>,
}

fn parse_contact(c: PersonConnection) -> GoogleContact {
    GoogleContact {
        resource_name: c.resource_name,
        name: c.names.first().and_then(|n| n.display_name.clone()),
        email: c.email_addresses.first().and_then(|e| e.value.clone()),
        phone: c.phone_numbers.first().and_then(|p| p.value.clone()),
        organization: c.organizations.first().and_then(|o| o.name.clone()),
        street_address: c.addresses.first().and_then(|a| a.street_address.clone()),
        city: c.addresses.first().and_then(|a| a.city.clone()),
        state: c.addresses.first().and_then(|a| a.region.clone()),
        zip_code: c.addresses.first().and_then(|a| a.postal_code.clone()),
    }
}

pub async fn list_contacts(access_token: &str) -> Result<Vec<GoogleContact>> {
    let client = reqwest::Client::new();
    let mut contacts = Vec::new();
    let mut page_token: Option<String> = None;

    loop {
        let mut url = "https://people.googleapis.com/v1/people/me/connections\
            ?personFields=names,emailAddresses,phoneNumbers,organizations,addresses\
            &pageSize=1000".to_string();
        if let Some(ref t) = page_token {
            url.push_str(&format!("&pageToken={}", t));
        }

        let resp = client
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| anyhow!("API request failed: {}", e))?;

        let data: PeopleResponse = resp
            .json()
            .await
            .map_err(|e| anyhow!("parse contacts failed: {}", e))?;

        for c in data.connections {
            contacts.push(parse_contact(c));
        }

        if data.next_page_token.is_none() {
            break;
        }
        page_token = data.next_page_token;
    }

    Ok(contacts)
}

pub async fn refresh_access_token(client_id: &str, client_secret: &str, refresh_token: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| anyhow!("token refresh failed: {}", e))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| anyhow!("parse token response: {}", e))?;

    json["access_token"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("no access_token in response"))
}
