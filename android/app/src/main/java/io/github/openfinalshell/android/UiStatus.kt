package io.github.openfinalshell.android

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource

/** Stable, localizable status identifiers emitted by view models. */
enum class StatusKey(@StringRes val resourceId: Int) {
    READY(R.string.status_ready),
    CONNECTING(R.string.status_connecting),
    AUTHENTICATING(R.string.status_authenticating),
    CONNECTED(R.string.status_connected),
    RECONNECTING(R.string.status_reconnecting),
    DISCONNECTED(R.string.status_disconnected),
    RECONNECTED(R.string.status_reconnected),
    TERMINAL_READY(R.string.status_terminal_ready),
    TERMINAL_CLOSED(R.string.status_terminal_closed),
    PROFILE_SAVED(R.string.status_profile_saved),
    PROFILE_DELETED(R.string.status_profile_deleted),
    FORWARDING_RULE_SAVED(R.string.status_forwarding_rule_saved),
    FORWARDING_RULE_DELETED(R.string.status_forwarding_rule_deleted),
    FORWARDING_STARTED(R.string.status_forwarding_started),
    PROXY_SAVED_UNAVAILABLE(R.string.status_proxy_saved_unavailable),
    PROXY_UNAVAILABLE(R.string.status_proxy_unavailable),
    PRIVATE_KEY_IMPORTED(R.string.status_private_key_imported),
    HOST_TRUST_REVOKED(R.string.status_host_trust_revoked),
    EXPORT_COMPLETED(R.string.status_export_completed),
    IMPORT_COMPLETED(R.string.status_import_completed),
    SESSION_REQUIRED(R.string.status_session_required),
    SERVER_INFO_UNAVAILABLE(R.string.status_server_info_unavailable),
    PORT_TRAFFIC_FAILED(R.string.status_port_traffic_failed),
    SFTP_READY(R.string.status_sftp_ready),
    SFTP_DIRECTORY_CREATED(R.string.status_sftp_directory_created),
    SFTP_ITEM_RENAMED(R.string.status_sftp_item_renamed),
    UPLOAD_QUEUED(R.string.status_upload_queued),
    DOWNLOAD_QUEUED(R.string.status_download_queued),
    HOST_KEY_CONFIRMATION_REQUIRED(R.string.status_host_key_confirmation_required),
    SSH_COMPONENTS_UNAVAILABLE(R.string.status_ssh_components_unavailable),
    ERROR_DETAIL(R.string.status_error_detail),
    LOCAL_STORAGE_UNAVAILABLE(R.string.status_local_storage_unavailable),
    FORWARDING_RULE_SAVE_FAILED(R.string.status_forwarding_rule_save_failed),
    FORWARDING_RULE_DELETE_FAILED(R.string.status_forwarding_rule_delete_failed),
    FORWARDING_START_FAILED(R.string.status_forwarding_start_failed),
    PROFILE_SAVE_FAILED(R.string.status_profile_save_failed),
    PROFILE_DELETE_FAILED(R.string.status_profile_delete_failed),
    GROUP_SAVE_FAILED(R.string.status_group_save_failed),
    GROUP_DELETE_FAILED(R.string.status_group_delete_failed),
    PROXY_SAVE_FAILED(R.string.status_proxy_save_failed),
    PROXY_DELETE_FAILED(R.string.status_proxy_delete_failed),
    PRIVATE_KEY_IMPORT_FAILED(R.string.status_private_key_import_failed),
    PRIVATE_KEY_DELETE_FAILED(R.string.status_private_key_delete_failed),
    HOST_TRUST_REVOKE_FAILED(R.string.status_host_trust_revoke_failed),
    EXPORT_FAILED(R.string.status_export_failed),
    IMPORT_FAILED(R.string.status_import_failed),
    CONNECTION_FAILED(R.string.status_connection_failed),
    SFTP_BROWSE_FAILED(R.string.status_sftp_browse_failed),
    SFTP_DELETE_FAILED(R.string.status_sftp_delete_failed),
    SFTP_UPLOAD_FAILED(R.string.status_sftp_upload_failed),
    SFTP_DOWNLOAD_FAILED(R.string.status_sftp_download_failed),
    SFTP_OPERATION_FAILED(R.string.status_sftp_operation_failed),
    TERMINAL_OPEN_FAILED(R.string.status_terminal_open_failed),
    TERMINAL_WRITE_FAILED(R.string.status_terminal_write_failed),
    SYNC_DEVICES_FOUND(R.string.status_sync_devices_found),
    SYNC_DEVICE_SCAN_FAILED(R.string.status_sync_device_scan_failed),
    SYNC_RECEIVER_READY(R.string.status_sync_receiver_ready),
    SYNC_RECEIVER_START_FAILED(R.string.status_sync_receiver_start_failed),
    SYNC_RECEIVER_STOPPED(R.string.status_sync_receiver_stopped),
    SYNC_PAIRING_CODE_INVALID(R.string.status_sync_pairing_code_invalid),
    SYNC_DELIVERED(R.string.status_sync_delivered),
    SYNC_FAILED(R.string.status_sync_failed),
    SYNC_INCOMING_CONFIRMATION_PENDING(R.string.status_sync_incoming_confirmation_pending),
    SYNC_REJECTED(R.string.status_sync_rejected),
    SYNC_IMPORT_FAILED(R.string.status_sync_import_failed),
    SYNC_IMPORTED(R.string.status_sync_imported)
}

data class UiStatus(
    val key: StatusKey = StatusKey.READY,
    val args: List<Any> = emptyList()
)

@Composable
fun uiStatusText(status: UiStatus): String = stringResource(
    status.key.resourceId,
    *status.args.toTypedArray()
)
