use zeroize::Zeroizing;

pub trait Credentials: Send + Sync {
    fn read(&self, id: &str) -> Result<Option<Zeroizing<String>>, String>;
    fn write(&self, id: &str, key: &str) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}
pub struct SystemCredentials;

#[cfg(windows)]
impl Credentials for SystemCredentials {
    fn read(&self, id: &str) -> Result<Option<Zeroizing<String>>, String> {
        use windows_sys::Win32::{
            Foundation::{GetLastError, ERROR_NOT_FOUND},
            Security::Credentials::*,
        };
        let target: Vec<u16> = format!("com.tan18.toolkit/llm/{id}\0")
            .encode_utf16()
            .collect();
        let mut ptr = std::ptr::null_mut();
        // CredRead allocates the result; always free it, including invalid UTF-8.
        unsafe {
            if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut ptr) == 0 {
                return if GetLastError() == ERROR_NOT_FOUND {
                    Ok(None)
                } else {
                    Err("Windows Credential Manager read failed".into())
                };
            }
            if (*ptr).CredentialBlobSize == 0 {
                CredFree(ptr.cast());
                return Ok(None);
            }
            let bytes = std::slice::from_raw_parts(
                (*ptr).CredentialBlob,
                (*ptr).CredentialBlobSize as usize,
            );
            let result = std::str::from_utf8(bytes)
                .map(|s| Zeroizing::new(s.to_owned()))
                .map_err(|_| "credential encoding is invalid".to_string());
            CredFree(ptr.cast());
            result.map(Some)
        }
    }
    fn write(&self, id: &str, key: &str) -> Result<(), String> {
        use windows_sys::Win32::Security::Credentials::*;
        if key.is_empty()
            || key.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize
            || key.contains(['\r', '\n'])
        {
            return Err("API key is empty, too long, or contains a newline".into());
        }
        let target: Vec<u16> = format!("com.tan18.toolkit/llm/{id}\0")
            .encode_utf16()
            .collect();
        let record = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_ptr().cast_mut(),
            CredentialBlobSize: key.len() as u32,
            CredentialBlob: key.as_ptr().cast_mut(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..unsafe { std::mem::zeroed() }
        };
        if unsafe { CredWriteW(&record, 0) } == 0 {
            Err("Windows Credential Manager write failed".into())
        } else {
            Ok(())
        }
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        use windows_sys::Win32::{
            Foundation::{GetLastError, ERROR_NOT_FOUND},
            Security::Credentials::*,
        };
        let target: Vec<u16> = format!("com.tan18.toolkit/llm/{id}\0")
            .encode_utf16()
            .collect();
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0
            || unsafe { GetLastError() } == ERROR_NOT_FOUND
        {
            Ok(())
        } else {
            Err("Windows Credential Manager delete failed".into())
        }
    }
}
#[cfg(not(windows))]
impl Credentials for SystemCredentials {
    fn read(&self, _: &str) -> Result<Option<Zeroizing<String>>, String> {
        Err("credential storage is only implemented on Windows".into())
    }
    fn write(&self, _: &str, _: &str) -> Result<(), String> {
        Err("credential storage is only implemented on Windows".into())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Err("credential storage is only implemented on Windows".into())
    }
}
