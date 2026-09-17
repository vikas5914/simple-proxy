export default defineEventHandler((event) => {
  setResponseHeader(event, "X-Robots-Tag", "noindex, nofollow");
});
