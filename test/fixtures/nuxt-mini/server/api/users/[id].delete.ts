export default defineEventHandler(async (event) => {
  return { deleted: getRouterParam(event, 'id') };
});
