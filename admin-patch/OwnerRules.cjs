'use strict';

// Serialized into the pinned Roles editor by the build patch. Dependencies come
// from the editor's own modules to preserve the host's React and Strapi contexts.
module.exports = function createOwnerRules(
  React,
  { Button, Checkbox, Flex, SingleSelect, SingleSelectOption, Typography },
  { useFetchClient, useAPIErrorHandler },
  { useMutation, useQuery, useQueryClient },
) {
  const h = React.createElement;

  return function OwnerRules({ id, selectedAction }) {
    const parts = selectedAction.split('.');
    const action = parts[3];
    const uid = parts[0] + '.' + parts[2];
    const endpoint = '/owner-permissions/roles/' + encodeURIComponent(id);
    const queryKey = ['owner-permissions', 'role', id];
    const { get, put } = useFetchClient();
    const { formatAPIError } = useAPIErrorHandler();
    const queryClient = useQueryClient();
    const [changes, setChanges] = React.useState(null);

    const query = useQuery(queryKey, async () => (await get(endpoint)).data.data);
    const save = useMutation(
      async (mappings) => (await put(endpoint, { mappings })).data.data,
      {
        onSuccess(data) {
          queryClient.setQueryData(queryKey, data);
          setChanges(null);
        },
      },
    );

    const coreActions = ['find', 'findOne', 'create', 'update', 'delete'];
    const validAction = parts.length === 4 && parts[0].startsWith('api::') &&
      parts[1] === 'controllers' && coreActions.includes(action);
    if (!validAction) return null;
    if (query.isLoading) return h(Typography, { role: 'status' }, 'Loading ownership rules…');
    if (query.isError) return h(Typography, { role: 'alert', textColor: 'danger600' }, formatAPIError(query.error));
    if (!query.data.canConfigure) return null;
    const content = query.data.eligible.find((item) => item.uid === uid);
    if (!content) return null;

    const mappings = changes ?? query.data.mappings;
    const saved = mappings[uid];
    const rule = typeof saved === 'string' ? { ownerField: saved, actions: coreActions } : saved;
    const enabled = rule?.actions.includes(action) ?? false;

    function edit(nextRule) {
      save.reset();
      const next = { ...mappings };
      if (nextRule.actions.length) next[uid] = nextRule;
      else delete next[uid];
      setChanges(next);
    }

    function toggle(checked) {
      const existing = rule?.actions ?? [];
      const actions = checked === true ? [...existing, action] : existing.filter((item) => item !== action);
      const onlyField = content.ownerFields.length === 1 ? content.ownerFields[0] : '';
      edit({ ownerField: rule?.ownerField || onlyField, actions });
    }

    function renderOwnerField() {
      if (!enabled) return null;
      if (content.ownerFields.length === 1) {
        return h(Typography, null, 'Owner field: ' + rule.ownerField + '. Strapi uses this field to identify the user who owns the record.');
      }
      return h(Flex, { direction: 'column', alignItems: 'stretch', gap: 2 },
        h(Typography, null, 'Choose the field that links a record to its owner. This field is shared by the restricted actions for this content type.'),
        h(SingleSelect, {
          'aria-label': 'Owner field',
          placeholder: 'Choose an owner field',
          value: rule.ownerField,
          onChange: (ownerField) => edit({ ...rule, ownerField }),
          disabled: save.isLoading,
        }, content.ownerFields.map((field) => h(SingleSelectOption, { key: field, value: field }, field))),
      );
    }

    const missingField = Object.values(mappings).some((item) => typeof item !== 'string' && !item.ownerField);

    return h(
      Flex,
      { direction: 'column', alignItems: 'stretch', gap: 3, tag: 'section', 'aria-label': 'User-generated content' },
      h(Typography, { tag: 'h2', variant: 'delta' }, 'User-generated content'),
      h(Checkbox, {
        checked: enabled,
        disabled: save.isLoading,
        onCheckedChange: toggle,
      }, 'Only own records'),
      h(Typography, null, action === 'create'
        ? 'New records belong to the user who creates them. The role must also have permission to create records.'
        : 'Limits this action to the user’s own records. The role must also have permission to run the action.'),
      renderOwnerField(),
      save.isError && h(Typography, { role: 'alert', textColor: 'danger600' }, formatAPIError(save.error)),
      save.isSuccess && h(Typography, { role: 'status', textColor: 'success600' }, 'Ownership rules saved.'),
      h(Button, {
        type: 'button',
        variant: 'secondary',
        disabled: !changes || missingField,
        loading: save.isLoading,
        onClick: () => save.mutate(mappings),
      }, 'Save ownership rules'),
    );
  };
};
