use toolkit_lib::{
    binary_ipc::{Transfers, EXPORT_TTL_MS, MAX_EXPORTS},
    services::caller::Caller,
};

pub async fn checks() {
    let store = Transfers::default();
    let donor = Caller::window("test.exchange", "main");
    let receiver = Caller::sidecar("test.exchange", "worker-generation-1");
    let key = Transfers::key(&donor, "source").unwrap();
    store.open(key.clone(), 4).unwrap();
    assert_eq!(
        store
            .offer(&donor, "source", &receiver.owner)
            .unwrap_err()
            .code,
        "conflict"
    );
    store.write(&key, 0, b"data").unwrap();
    store.seal(&key).unwrap();
    let ticket = store.offer(&donor, "source", &receiver.owner).unwrap();
    let token = ticket["token"].as_str().unwrap();
    assert_eq!(
        store
            .import(
                &Caller::sidecar("another.plugin", "worker-generation-1"),
                token
            )
            .unwrap_err()
            .code,
        "denied"
    );
    assert_eq!(
        store
            .import(
                &Caller::sidecar("test.exchange", "worker-generation-2"),
                token
            )
            .unwrap_err()
            .code,
        "denied"
    );
    let imported = store.import(&receiver, token).unwrap();
    assert_eq!(
        store.import(&receiver, token).unwrap_err().code,
        "not_found"
    );
    let imported_key =
        Transfers::key(&receiver, imported["source"]["id"].as_str().unwrap()).unwrap();
    let original = store.borrow(&key).unwrap();
    let shared = store.borrow(&imported_key).unwrap();
    assert!(std::sync::Arc::ptr_eq(&original, &shared));
    assert_eq!(store.diagnostics()["bytes"], 4);
    let reverse = store
        .offer(&receiver, &imported_key.id, &donor.owner)
        .unwrap();
    let returned = store
        .import(&donor, reverse["token"].as_str().unwrap())
        .unwrap();
    let returned_key = Transfers::key(&donor, returned["source"]["id"].as_str().unwrap()).unwrap();
    assert!(std::sync::Arc::ptr_eq(
        &original,
        &store.borrow(&returned_key).unwrap()
    ));
    store.close(&key);
    assert_eq!(store.read(&imported_key, 0, 4).unwrap(), b"data");
    assert!(store.write(&imported_key, 0, b"nope").is_err());
    let ticket = store
        .offer(&receiver, &imported_key.id, &donor.owner)
        .unwrap();
    let token = ticket["token"].as_str().unwrap();
    assert_eq!(store.revoke(&donor, token).unwrap_err().code, "denied");
    store.revoke(&receiver, token).unwrap();
    assert!(store.import(&donor, token).is_err());
    let mut pending = Vec::new();
    for _ in 0..MAX_EXPORTS {
        pending.push(
            store
                .offer(&receiver, &imported_key.id, &donor.owner)
                .unwrap(),
        );
    }
    assert_eq!(
        store
            .offer(&receiver, &imported_key.id, &donor.owner)
            .unwrap_err()
            .code,
        "conflict"
    );
    for ticket in pending {
        store
            .revoke(&receiver, ticket["token"].as_str().unwrap())
            .unwrap();
    }
    let ticket = store
        .offer(&receiver, &imported_key.id, &donor.owner)
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(EXPORT_TTL_MS + 100)).await;
    assert_eq!(
        store
            .import(&donor, ticket["token"].as_str().unwrap())
            .unwrap_err()
            .code,
        "not_found"
    );
    let ticket = store
        .offer(&receiver, &imported_key.id, &donor.owner)
        .unwrap();
    store.close_caller(&receiver);
    assert!(store
        .import(&donor, ticket["token"].as_str().unwrap())
        .is_err());
    store.close_caller(&donor);
    drop(original);
    drop(shared);
    assert_eq!(store.diagnostics()["bytes"], 0);
    println!("PASS resource exchange: target generation/plugin checks, one-use/revoke/real TTL, immutable shared allocation, reverse exchange and caller cleanup");
}
