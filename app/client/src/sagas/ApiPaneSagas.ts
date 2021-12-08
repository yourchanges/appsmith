/**
 * Handles the Api pane ui state. It looks into the routing based on actions too
 * */
import get from "lodash/get";
import omit from "lodash/omit";
import cloneDeep from "lodash/cloneDeep";
import { all, select, put, takeEvery, call, take } from "redux-saga/effects";
import * as Sentry from "@sentry/react";
import {
  ReduxAction,
  ReduxActionErrorTypes,
  ReduxActionTypes,
  ReduxActionWithMeta,
  ReduxFormActionTypes,
} from "constants/ReduxActionConstants";
import { getFormData } from "selectors/formSelectors";
import { API_EDITOR_FORM_NAME, SAAS_EDITOR_FORM } from "constants/forms";
import {
  DEFAULT_API_ACTION_CONFIG,
  POST_BODY_FORMAT_OPTIONS_ARRAY,
  POST_BODY_FORMAT_OPTIONS,
  REST_PLUGIN_PACKAGE_NAME,
  CONTENT_TYPE_HEADER_KEY,
  EMPTY_KEY_VALUE_PAIRS,
  HTTP_METHODS,
} from "constants/ApiEditorConstants";
import history from "utils/history";
import {
  API_EDITOR_ID_URL,
  DATA_SOURCES_EDITOR_ID_URL,
  INTEGRATION_EDITOR_MODES,
  INTEGRATION_EDITOR_URL,
  INTEGRATION_TABS,
} from "constants/routes";
import {
  getCurrentApplicationId,
  getCurrentPageId,
} from "selectors/editorSelectors";
import { initialize, autofill, change } from "redux-form";
import { Property } from "api/ActionAPI";
import {
  createNewApiName,
  getNextEntityName,
  getQueryParams,
} from "utils/AppsmithUtils";
import { getPluginIdOfPackageName } from "sagas/selectors";
import {
  getAction,
  getActions,
  getPlugins,
  getDatasources,
  getPlugin,
} from "selectors/entitiesSelector";
import { ActionData } from "reducers/entityReducers/actionsReducer";
import {
  createActionRequest,
  setActionProperty,
} from "actions/pluginActionActions";
import { Datasource } from "entities/Datasource";
import { Plugin } from "api/PluginApi";
import { PLUGIN_PACKAGE_DBS } from "constants/QueryEditorConstants";
import { Action, ApiAction, PluginType } from "entities/Action";
import { getCurrentOrgId } from "selectors/organizationSelectors";
import log from "loglevel";
import PerformanceTracker, {
  PerformanceTransactionName,
} from "utils/PerformanceTracker";
import { EventLocation } from "utils/AnalyticsUtil";
import { Variant } from "components/ads/common";
import { Toaster } from "components/ads/Toast";
import { createMessage, ERROR_ACTION_RENAME_FAIL } from "constants/messages";
import { checkCurrentStep } from "./OnboardingSagas";
import { OnboardingStep } from "constants/OnboardingConstants";
import {
  getIndextoUpdate,
  parseUrlForQueryParams,
  queryParamsRegEx,
} from "utils/ApiPaneUtils";
import { updateReplayEntity } from "actions/pageActions";
import { ENTITY_TYPE } from "entities/AppsmithConsole";

function* syncApiParamsSaga(
  actionPayload: ReduxActionWithMeta<string, { field: string }>,
  actionId: string,
) {
  const field = actionPayload.meta.field;
  //Payload here contains the path and query params of a typical url like https://{domain}/{path}?{query_params}
  const value = actionPayload.payload;
  // Regular expression to find the query params group
  PerformanceTracker.startTracking(PerformanceTransactionName.SYNC_PARAMS_SAGA);
  if (field === "actionConfiguration.path") {
    const params = parseUrlForQueryParams(value);
    yield put(
      autofill(
        API_EDITOR_FORM_NAME,
        "actionConfiguration.queryParameters",
        params,
      ),
    );
    yield put(
      setActionProperty({
        actionId: actionId,
        propertyName: "actionConfiguration.queryParameters",
        value: params,
      }),
    );
  } else if (field.includes("actionConfiguration.queryParameters")) {
    const { values } = yield select(getFormData, API_EDITOR_FORM_NAME);
    const path = values.actionConfiguration.path || "";
    const matchGroups = path.match(queryParamsRegEx) || [];
    const currentPath = matchGroups[1] || "";
    const paramsString = values.actionConfiguration.queryParameters
      .filter((p: Property) => p.key)
      .map(
        (p: Property, i: number) => `${i === 0 ? "?" : "&"}${p.key}=${p.value}`,
      )
      .join("");
    yield put(
      autofill(
        API_EDITOR_FORM_NAME,
        "actionConfiguration.path",
        `${currentPath}${paramsString}`,
      ),
    );
  }
  PerformanceTracker.stopTracking();
}

function* redirectToNewIntegrations(
  action: ReduxAction<{
    applicationId: string;
    pageId: string;
    params?: Record<string, string>;
  }>,
) {
  history.push(
    INTEGRATION_EDITOR_URL(
      action.payload.applicationId,
      action.payload.pageId,
      INTEGRATION_TABS.ACTIVE,
      INTEGRATION_EDITOR_MODES.AUTO,
      action.payload.params,
    ),
  );
}

function* handleUpdateBodyContentType(
  action: ReduxAction<{ title: string; apiId: string }>,
) {
  const { apiId, title } = action.payload;
  const { values } = yield select(getFormData, API_EDITOR_FORM_NAME);
  // this is a previous value gotten before the updated content type has been set
  const previousContentType =
    values.actionConfiguration.formData.apiContentType;

  const displayFormatValue = POST_BODY_FORMAT_OPTIONS_ARRAY.find(
    (el) => el === title,
  );
  if (!displayFormatValue) {
    log.error("Display format not supported", title);
    return;
  }

  // this is the update for the new api contentType
  // update the api content type so it can be persisted.
  let formData = cloneDeep(values.actionConfiguration.formData);
  if (formData === undefined) formData = {};
  formData["apiContentType"] = title;

  yield put(
    change(API_EDITOR_FORM_NAME, "actionConfiguration.formData", formData),
  );

  if (displayFormatValue === POST_BODY_FORMAT_OPTIONS.RAW) {
    // update the content type header if raw has been selected
    yield put({
      type: ReduxActionTypes.SET_EXTRA_FORMDATA,
      payload: {
        id: apiId,
        values: {
          displayFormat: {
            label: displayFormatValue,
            value: displayFormatValue,
          },
        },
      },
    });
  }

  const headers = cloneDeep(values.actionConfiguration.headers);

  const contentTypeHeaderIndex = headers.findIndex(
    (element: { key: string; value: string }) =>
      element &&
      element.key &&
      element.key.trim().toLowerCase() === CONTENT_TYPE_HEADER_KEY,
  );
  const indexToUpdate = getIndextoUpdate(headers, contentTypeHeaderIndex);

  // If the user has selected "None" as the body type & there was a content-type
  // header present in the API configuration, keep the previous content type header
  // but if the user has selected "raw", set the content header to text/plain
  if (
    displayFormatValue === POST_BODY_FORMAT_OPTIONS.NONE &&
    indexToUpdate !== -1
  ) {
    headers[indexToUpdate] = {
      key: previousContentType ? CONTENT_TYPE_HEADER_KEY : "",
      value: previousContentType ? previousContentType : "",
    };
  } else if (
    displayFormatValue === POST_BODY_FORMAT_OPTIONS.RAW &&
    indexToUpdate !== -1
  ) {
    headers[indexToUpdate] = {
      key: CONTENT_TYPE_HEADER_KEY,
      value: POST_BODY_FORMAT_OPTIONS.RAW,
    };
  } else {
    headers[indexToUpdate] = {
      key: CONTENT_TYPE_HEADER_KEY,
      value: displayFormatValue,
    };
  }

  yield put(
    change(API_EDITOR_FORM_NAME, "actionConfiguration.headers", headers),
  );

  const bodyFormData = cloneDeep(values.actionConfiguration.bodyFormData);

  if (
    displayFormatValue === POST_BODY_FORMAT_OPTIONS.FORM_URLENCODED ||
    displayFormatValue === POST_BODY_FORMAT_OPTIONS.MULTIPART_FORM_DATA
  ) {
    if (!bodyFormData || bodyFormData.length === 0) {
      yield put(
        change(
          API_EDITOR_FORM_NAME,
          "actionConfiguration.bodyFormData",
          EMPTY_KEY_VALUE_PAIRS.slice(),
        ),
      );
    }
  }
}

function* initializeExtraFormDataSaga() {
  const state = yield select();
  const { extraformData } = state.ui.apiPane;
  const formData = yield select(getFormData, API_EDITOR_FORM_NAME);
  const { values } = formData;
  // const headers = get(values, "actionConfiguration.headers");
  const apiContentType = get(
    values,
    "actionConfiguration.formData.apiContentType",
  );

  if (!extraformData[values.id]) {
    yield call(setHeaderFormat, values.id, apiContentType);
  }
}

function* changeApiSaga(
  actionPayload: ReduxAction<{ id: string; isSaas: boolean; action?: Action }>,
) {
  PerformanceTracker.startTracking(PerformanceTransactionName.CHANGE_API_SAGA);
  const { id, isSaas } = actionPayload.payload;
  let { action } = actionPayload.payload;
  if (!action) action = yield select(getAction, id);
  if (!action) return;
  if (isSaas) {
    yield put(initialize(SAAS_EDITOR_FORM, action));
  } else {
    yield put(initialize(API_EDITOR_FORM_NAME, action));

    yield call(initializeExtraFormDataSaga);

    if (
      action.actionConfiguration &&
      action.actionConfiguration.queryParameters?.length
    ) {
      // Sync the api params my mocking a change action
      yield call(
        syncApiParamsSaga,
        {
          type: ReduxFormActionTypes.ARRAY_REMOVE,
          payload: action.actionConfiguration.queryParameters,
          meta: {
            field: "actionConfiguration.queryParameters",
          },
        },
        id,
      );
    }
  }

  //Retrieve form data with synced query params to start tracking change history.
  const { values: actionPostProcess } = yield select(
    getFormData,
    API_EDITOR_FORM_NAME,
  );
  PerformanceTracker.stopTracking();
  yield put(updateReplayEntity(id, actionPostProcess, ENTITY_TYPE.ACTION));
}

function* setHeaderFormat(apiId: string, apiContentType?: string) {
  // use the current apiContentType to set appropriate Headers for action
  let displayFormat;
  if (apiContentType) {
    if (apiContentType === POST_BODY_FORMAT_OPTIONS.NONE) {
      displayFormat = {
        label: POST_BODY_FORMAT_OPTIONS.NONE,
        value: POST_BODY_FORMAT_OPTIONS.NONE,
      };
    } else if (
      apiContentType !== POST_BODY_FORMAT_OPTIONS.NONE &&
      Object.values(POST_BODY_FORMAT_OPTIONS).includes(apiContentType)
    ) {
      displayFormat = {
        label: apiContentType,
        value: apiContentType,
      };
    } else {
      displayFormat = {
        label: POST_BODY_FORMAT_OPTIONS.RAW,
        value: POST_BODY_FORMAT_OPTIONS.RAW,
      };
    }
  }

  yield put({
    type: ReduxActionTypes.SET_EXTRA_FORMDATA,
    payload: {
      id: apiId,
      values: {
        displayFormat,
      },
    },
  });
}

export function* updateFormFields(
  actionPayload: ReduxActionWithMeta<string, { field: string }>,
) {
  const field = actionPayload.meta.field;
  const value = actionPayload.payload;
  log.debug("updateFormFields: " + JSON.stringify(value));
  const { values } = yield select(getFormData, API_EDITOR_FORM_NAME);
  let apiContentType = values.actionConfiguration.formData.apiContentType;

  if (field === "actionConfiguration.httpMethod") {
    const { actionConfiguration } = values;
    if (!actionConfiguration.headers) return;

    const actionConfigurationHeaders = cloneDeep(actionConfiguration.headers);
    const contentTypeHeaderIndex = actionConfigurationHeaders.findIndex(
      (header: { key: string; value: string }) =>
        header &&
        header.key &&
        header.key.trim().toLowerCase() === CONTENT_TYPE_HEADER_KEY,
    );

    if (value !== HTTP_METHODS.GET) {
      // if user switches to other methods that is not GET and apiContentType is undefined set default apiContentType to JSON.
      if (apiContentType === POST_BODY_FORMAT_OPTIONS.NONE)
        apiContentType = POST_BODY_FORMAT_OPTIONS.JSON;

      const indexToUpdate = getIndextoUpdate(
        actionConfigurationHeaders,
        contentTypeHeaderIndex,
      );
      actionConfigurationHeaders[indexToUpdate] = {
        key: CONTENT_TYPE_HEADER_KEY,
        value: apiContentType,
      };
    } else {
      log.debug("yoyo: Got the GET request");
      // when user switches to GET method, do not clear off content type headers, instead leave them.
      if (contentTypeHeaderIndex > -1) {
        actionConfigurationHeaders[contentTypeHeaderIndex] = {
          key: CONTENT_TYPE_HEADER_KEY,
          value: apiContentType,
        };
      }
    }
    // change apiContentType when user changes api Http Method
    yield put(
      change(
        API_EDITOR_FORM_NAME,
        "actionConfiguration.formData.apiContentType",
        apiContentType,
      ),
    );
    yield put(
      change(
        API_EDITOR_FORM_NAME,
        "actionConfiguration.headers",
        actionConfigurationHeaders,
      ),
    );
  } else if (field.includes("actionConfiguration.headers")) {
    const apiId = get(values, "id");
    yield call(setHeaderFormat, apiId, apiContentType);
  }
}

function* formValueChangeSaga(
  actionPayload: ReduxActionWithMeta<string, { field: string; form: string }>,
) {
  const { field, form } = actionPayload.meta;
  if (form !== API_EDITOR_FORM_NAME) return;
  if (field === "dynamicBindingPathList" || field === "name") return;
  const { values } = yield select(getFormData, API_EDITOR_FORM_NAME);
  if (!values.id) return;
  const contentTypeHeaderIndex = values.actionConfiguration.headers.findIndex(
    (header: { key: string; value: string }) =>
      header &&
      header.key &&
      header.key.trim().toLowerCase() === CONTENT_TYPE_HEADER_KEY,
  );
  if (
    actionPayload.type === ReduxFormActionTypes.ARRAY_REMOVE ||
    actionPayload.type === ReduxFormActionTypes.ARRAY_PUSH
  ) {
    const value = get(values, field);
    yield put(
      setActionProperty({
        actionId: values.id,
        propertyName: field,
        value,
      }),
    );
  } else {
    yield put(
      setActionProperty({
        actionId: values.id,
        propertyName: field,
        value: actionPayload.payload,
      }),
    );
    // when user types a content type value, update actionConfiguration.formData.apiContent type as well.
    if (
      field === `actionConfiguration.headers[${contentTypeHeaderIndex}].value`
    ) {
      if (
        // if the value is not a registered content type, make the default apiContentType raw but don't change header
        Object.values(POST_BODY_FORMAT_OPTIONS).includes(actionPayload.payload)
      ) {
        yield put(
          change(
            API_EDITOR_FORM_NAME,
            "actionConfiguration.formData.apiContentType",
            actionPayload.payload,
          ),
        );
      } else {
        yield put(
          change(
            API_EDITOR_FORM_NAME,
            "actionConfiguration.formData.apiContentType",
            POST_BODY_FORMAT_OPTIONS.RAW,
          ),
        );
      }
    }
  }
  yield all([
    call(syncApiParamsSaga, actionPayload, values.id),
    call(updateFormFields, actionPayload),
  ]);

  // We need to refetch form values here since syncApuParams saga and updateFormFields directly update reform form values.
  const { values: formValuesPostProcess } = yield select(
    getFormData,
    API_EDITOR_FORM_NAME,
  );

  yield put(
    updateReplayEntity(
      formValuesPostProcess.id,
      formValuesPostProcess,
      ENTITY_TYPE.ACTION,
    ),
  );
}

function* handleActionCreatedSaga(actionPayload: ReduxAction<Action>) {
  const { id, pluginType } = actionPayload.payload;
  const action = yield select(getAction, id);
  const data = { ...action };

  if (pluginType === PluginType.API) {
    yield put(initialize(API_EDITOR_FORM_NAME, omit(data, "name")));
    const applicationId: string = yield select(getCurrentApplicationId);
    const pageId: string = yield select(getCurrentPageId);
    history.push(
      API_EDITOR_ID_URL(applicationId, pageId, id, {
        editName: "true",
        from: "datasources",
      }),
    );
  }
}

function* handleDatasourceCreatedSaga(actionPayload: ReduxAction<Datasource>) {
  const plugin = yield select(getPlugin, actionPayload.payload.pluginId);
  // Only look at API plugins
  if (plugin.type !== PluginType.API) return;

  const pageId = yield select(getCurrentPageId);
  const applicationId = yield select(getCurrentApplicationId);

  history.push(
    DATA_SOURCES_EDITOR_ID_URL(
      applicationId,
      pageId,
      actionPayload.payload.id,
      {
        from: "datasources",
        ...getQueryParams(),
      },
    ),
  );
}

function* handleCreateNewApiActionSaga(
  action: ReduxAction<{ pageId: string; from: EventLocation }>,
) {
  const organizationId = yield select(getCurrentOrgId);
  const pluginId = yield select(
    getPluginIdOfPackageName,
    REST_PLUGIN_PACKAGE_NAME,
  );
  const { pageId } = action.payload;
  if (pageId && pluginId) {
    const actions = yield select(getActions);
    const pageActions = actions.filter(
      (a: ActionData) => a.config.pageId === pageId,
    );
    const newActionName = createNewApiName(pageActions, pageId);
    // Note: Do NOT send pluginId on top level here.
    // It breaks embedded rest datasource flow.
    yield put(
      createActionRequest({
        actionConfiguration: DEFAULT_API_ACTION_CONFIG,
        name: newActionName,
        datasource: {
          name: "DEFAULT_REST_DATASOURCE",
          pluginId,
          organizationId,
        },
        eventData: {
          actionType: "API",
          from: action.payload.from,
        },
        pageId,
      } as ApiAction), // We don't have recursive partial in typescript for now.
    );
  }
}

function* handleCreateNewQueryActionSaga(
  action: ReduxAction<{ pageId: string; from: EventLocation }>,
) {
  const { pageId } = action.payload;
  const applicationId = yield select(getCurrentApplicationId);
  const actions = yield select(getActions);
  const dataSources = yield select(getDatasources);
  const plugins = yield select(getPlugins);
  const pluginIds = plugins
    .filter((plugin: Plugin) => PLUGIN_PACKAGE_DBS.includes(plugin.packageName))
    .map((plugin: Plugin) => plugin.id);
  const validDataSources: Array<Datasource> = [];
  dataSources.forEach((dataSource: Datasource) => {
    if (pluginIds?.includes(dataSource.pluginId)) {
      validDataSources.push(dataSource);
    }
  });
  if (validDataSources.length) {
    const pageApiNames = actions
      .filter((a: ActionData) => a.config.pageId === pageId)
      .map((a: ActionData) => a.config.name);
    const newQueryName = getNextEntityName("Query", pageApiNames);
    const dataSourceId = validDataSources[0].id;
    let createActionPayload = {
      name: newQueryName,
      pageId,
      datasource: {
        id: dataSourceId,
      },
      eventData: {
        actionType: "Query",
        from: action.payload.from,
        dataSource: validDataSources[0].name,
      },
      actionConfiguration: {},
    };

    //For onboarding
    const updateActionPayload = yield select(
      checkCurrentStep,
      OnboardingStep.ADD_INPUT_WIDGET,
    );
    if (updateActionPayload) {
      createActionPayload = {
        ...createActionPayload,
        name: "add_standup_updates",
        actionConfiguration: {
          body: `Insert into standup_updates("name", "notes") values ('{{appsmith.user.email}}', '{{ Standup_Input.text }}')`,
        },
      };
    }

    yield put(createActionRequest(createActionPayload));
  } else {
    history.push(
      INTEGRATION_EDITOR_URL(applicationId, pageId, INTEGRATION_TABS.ACTIVE),
    );
  }
}

function* handleApiNameChangeSaga(
  action: ReduxAction<{ id: string; name: string }>,
) {
  yield put(change(API_EDITOR_FORM_NAME, "name", action.payload.name));
}
function* handleApiNameChangeSuccessSaga(
  action: ReduxAction<{ actionId: string }>,
) {
  const { actionId } = action.payload;
  const actionObj = yield select(getAction, actionId);
  yield take(ReduxActionTypes.FETCH_ACTIONS_FOR_PAGE_SUCCESS);
  if (!actionObj) {
    // Error case, log to sentry
    Toaster.show({
      text: createMessage(ERROR_ACTION_RENAME_FAIL, ""),
      variant: Variant.danger,
    });

    Sentry.captureException(
      new Error(createMessage(ERROR_ACTION_RENAME_FAIL, "")),
      {
        extra: {
          actionId: actionId,
        },
      },
    );
    return;
  }
  if (actionObj.pluginType === PluginType.API) {
    const params = getQueryParams();
    if (params.editName) {
      params.editName = "false";
    }
    const applicationId = yield select(getCurrentApplicationId);
    const pageId = yield select(getCurrentPageId);
    history.push(API_EDITOR_ID_URL(applicationId, pageId, actionId, params));
  }
}

function* handleApiNameChangeFailureSaga(
  action: ReduxAction<{ oldName: string }>,
) {
  yield put(change(API_EDITOR_FORM_NAME, "name", action.payload.oldName));
}

export default function* root() {
  yield all([
    takeEvery(ReduxActionTypes.API_PANE_CHANGE_API, changeApiSaga),
    takeEvery(ReduxActionTypes.CREATE_ACTION_SUCCESS, handleActionCreatedSaga),
    takeEvery(
      ReduxActionTypes.CREATE_DATASOURCE_SUCCESS,
      handleDatasourceCreatedSaga,
    ),
    takeEvery(ReduxActionTypes.SAVE_ACTION_NAME_INIT, handleApiNameChangeSaga),
    takeEvery(
      ReduxActionTypes.SAVE_ACTION_NAME_SUCCESS,
      handleApiNameChangeSuccessSaga,
    ),
    takeEvery(
      ReduxActionErrorTypes.SAVE_ACTION_NAME_ERROR,
      handleApiNameChangeFailureSaga,
    ),
    takeEvery(
      ReduxActionTypes.CREATE_NEW_API_ACTION,
      handleCreateNewApiActionSaga,
    ),
    takeEvery(
      ReduxActionTypes.CREATE_NEW_QUERY_ACTION,
      handleCreateNewQueryActionSaga,
    ),
    takeEvery(
      ReduxActionTypes.UPDATE_API_ACTION_BODY_CONTENT_TYPE,
      handleUpdateBodyContentType,
    ),
    takeEvery(
      ReduxActionTypes.REDIRECT_TO_NEW_INTEGRATIONS,
      redirectToNewIntegrations,
    ),
    // Intercepting the redux-form change actionType
    takeEvery(ReduxFormActionTypes.VALUE_CHANGE, formValueChangeSaga),
    takeEvery(ReduxFormActionTypes.ARRAY_REMOVE, formValueChangeSaga),
    takeEvery(ReduxFormActionTypes.ARRAY_PUSH, formValueChangeSaga),
  ]);
}
