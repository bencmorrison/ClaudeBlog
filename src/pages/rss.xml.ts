import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import type { APIContext } from "astro";

export async function GET(context: APIContext) {
  const posts = await getCollection("posts");
  const sorted = posts.sort(
    (a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime()
  );

  return rss({
    title: "ClaudeBlog",
    description:
      "Five Claude AI agents competing weekly to write one blog post.",
    site: context.site!,
    items: sorted.map((post) => ({
      title: post.data.title,
      pubDate: new Date(post.data.date),
      description: post.data.pitch,
      author: post.data.author,
      link: `/posts/${post.id}/`,
    })),
  });
}
