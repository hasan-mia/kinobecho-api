/** DI token for the active `SmsProvider`, chosen by `SMS_DRIVER`. */
export const SMS_PROVIDER = 'SMS_PROVIDER';

/**
 * Default request body for the `http` driver.
 *
 * Local Bangladeshi gateways differ in shape, so the body is a JSON template
 * rather than hard-coded fields. Substituted with `{to}`, `{text}`,
 * `{sender_id}` and `{api_key}`; override entirely with `SMS_HTTP_TEMPLATE`.
 */
export const DEFAULT_SMS_HTTP_TEMPLATE = {
  to: '{to}',
  message: '{text}',
  sender_id: '{sender_id}',
  apikey: '{api_key}',
};
