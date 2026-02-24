const _viewSchemas = {
  feed: ["id", "title", "text"],
  home: ["id", "title", "?text", "images"],
  profile: ["id", "title", "text", "images", "author.!id", "author.?name"],
};
// Post with all property types defined, but not all properties are required
interface _Post {
  id: string;
  user_id: string;
  text: string;
  title: string;
  images: string[];
  upvotes_count: number;
  comments_count: number;
  author: {
    id: string;
    name: string;
  };
}
