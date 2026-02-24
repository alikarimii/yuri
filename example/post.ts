const _viewSchemas = {
  feed: ["id", "title", "text"],
  home: ["id", "title", "text", "images"],
  profile: ["id", "title", "text", "images", "author.!id"],
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

export interface PostFeedViewModel {
  id: string;
  title: string;
  text: string;
}
export interface PostHomeViewModel {
  id: string;
  title: string;
  text: string;
  images: string[];
}
export interface PostProfileViewModel {
  id: string;
  title: string;
  text: string;
  images: string[];
  author: { name: string };
}
