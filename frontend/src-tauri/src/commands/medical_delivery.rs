use keyring::Entry;
use serde::{Deserialize, Serialize};

const DELIVERY_KEYRING_SERVICE: &str = "stirling-pdf-medical-redact-delivery";
const DELIVERY_CREDENTIAL_ERROR: &str = "MR-DELIVERY-8502";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MedicalDeliveryCredentials {
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub private_key_passphrase: Option<String>,
    pub archive_password: Option<String>,
}

fn validate_profile_id(profile_id: &str) -> Result<&str, String> {
    let valid = !profile_id.is_empty()
        && profile_id.len() <= 64
        && profile_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(profile_id)
    } else {
        Err(DELIVERY_CREDENTIAL_ERROR.to_string())
    }
}

fn entry(profile_id: &str) -> Result<Entry, String> {
    let account = validate_profile_id(profile_id)?;
    Entry::new(DELIVERY_KEYRING_SERVICE, account).map_err(|_| DELIVERY_CREDENTIAL_ERROR.to_string())
}

#[tauri::command]
pub async fn save_medical_delivery_credentials(
    profile_id: String,
    credentials: MedicalDeliveryCredentials,
) -> Result<(), String> {
    let serialized =
        serde_json::to_string(&credentials).map_err(|_| DELIVERY_CREDENTIAL_ERROR.to_string())?;
    let credential = entry(&profile_id)?;
    credential
        .set_password(&serialized)
        .map_err(|_| DELIVERY_CREDENTIAL_ERROR.to_string())?;
    match credential.get_password() {
        Ok(saved) if saved == serialized => Ok(()),
        _ => Err(DELIVERY_CREDENTIAL_ERROR.to_string()),
    }
}

#[tauri::command]
pub async fn get_medical_delivery_credentials(
    profile_id: String,
) -> Result<Option<MedicalDeliveryCredentials>, String> {
    match entry(&profile_id)?.get_password() {
        Ok(serialized) => serde_json::from_str(&serialized)
            .map(Some)
            .map_err(|_| DELIVERY_CREDENTIAL_ERROR.to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(DELIVERY_CREDENTIAL_ERROR.to_string()),
    }
}

#[tauri::command]
pub async fn clear_medical_delivery_credentials(profile_id: String) -> Result<(), String> {
    let credential = entry(&profile_id)?;
    match credential.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(DELIVERY_CREDENTIAL_ERROR.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_id_is_limited_to_safe_keyring_account_characters() {
        assert_eq!(
            validate_profile_id("default-profile").unwrap(),
            "default-profile"
        );
        assert!(validate_profile_id("../unsafe").is_err());
        assert!(validate_profile_id("space value").is_err());
        assert!(validate_profile_id("").is_err());
    }

    #[test]
    fn credentials_serialize_without_changing_field_names() {
        let credentials = MedicalDeliveryCredentials {
            password: Some("secret".to_string()),
            private_key: None,
            private_key_passphrase: None,
            archive_password: Some("archive-secret".to_string()),
        };
        let serialized = serde_json::to_string(&credentials).unwrap();
        assert!(serialized.contains("\"archivePassword\""));
        assert!(!serialized.contains("archive_password"));
    }
}
