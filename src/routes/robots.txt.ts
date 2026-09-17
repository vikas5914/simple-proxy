export default defineEventHandler((event) => {
  setResponseHeader(event, "Content-Type", "text/plain");
  return "User-agent: *\nDisallow: /\n";
});
