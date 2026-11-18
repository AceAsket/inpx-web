use hyper::{Method, Request, Response, StatusCode, body::Incoming, header};
use serde_json::{Value, json};

use super::{State, VERSION, send_bytes};
use crate::http::{Body, error};

pub(super) fn is_poll(request: &Request<Incoming>) -> bool {
    matches!(*request.method(), Method::GET | Method::HEAD)
        && request.uri().query() == Some("inpxStartupStatus=1")
}

pub(super) fn response(state: &State, request: &Request<Incoming>) -> Response<Body> {
    let head = request.method() == Method::HEAD;
    let path = request.uri().path();
    let document = state.socket.document(path);
    if !(head || request.method() == Method::GET) || crate::http::is_websocket(request.headers()) {
        return error(StatusCode::SERVICE_UNAVAILABLE);
    }
    if document && !is_poll(request) {
        return send_bytes(
            include_bytes!("startup.html").to_vec(),
            "text/html; charset=utf-8",
            head,
        );
    }
    let path = path.trim_end_matches('/');
    if !(document || matches!(path, "/api/index-status" | "/ready" | "/health")) {
        return error(StatusCode::SERVICE_UNAVAILABLE);
    }
    let index = state.index.snapshot();
    let stage = match index["job"].as_str().unwrap_or("") {
        "migration" => "Подготовка переноса",
        "sources" => "Проверка источников",
        "previous identities" => "Чтение прежних идентификаторов книг",
        "load inpx" => "Загрузка записей библиотеки",
        "book save" => "Сохранение книг",
        "lookup order" => "Сортировка поискового индекса",
        "lookup" => "Запись поискового индекса",
        "validate" => "Проверка готового индекса",
        "checkpoint" => "Сохранение готового индекса",
        "resume" => "Восстановление сохранённого индекса",
        "migration-reset" => "Повторное построение изменившегося каталога",
        "publish" => "Подключение готового индекса",
        _ => "Открытие каталога",
    };
    let mut status = json!({"ready":false,"serverReady":true,"indexReady":false,"updating":true,
        "status":if path=="/health" {"ok"} else {"waiting"},"state":"starting","version":VERSION,
        "migration":index["migration"]==true,"job":index["job"],"jobMessage":stage,
        "recsLoaded":index["recsLoaded"],"totalRecords":index["totalRecords"],
        "current":index["current"],"totalFiles":index["totalFiles"],"elapsedSeconds":state.started.elapsed().as_secs()});
    if !state.access.library.protected() {
        status["sourceName"] = index.get("sourceName").cloned().unwrap_or(Value::Null);
    }
    let mut response = send_bytes(
        serde_json::to_vec(&status).unwrap(),
        "application/json; charset=utf-8",
        head,
    );
    if path == "/ready" {
        *response.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, header::HeaderValue::from_static("2"));
    }
    response
}
