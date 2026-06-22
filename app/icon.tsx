import { ImageResponse } from "next/og";

// Route segment config
export const runtime = "edge";

// Image metadata
export const size = {
  width: 32,
  height: 32,
};
export const contentType = "image/png";

// Image generation
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          fontSize: 24,
          background: "linear-gradient(135deg, #2f6bff 0%, #1d4ed8 100%)",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "white",
          borderRadius: "8px",
          padding: "4px",
        }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20.4993 12.5C20.5 12.1804 20.5 11.8473 20.5 11.5C20.5 7.25736 20.5 5.13604 19.182 3.81802C17.864 2.5 15.7426 2.5 11.5 2.5C7.25736 2.5 5.13604 2.5 3.81802 3.81802C2.5 5.13604 2.5 7.25736 2.5 11.5C2.5 15.7426 2.5 17.864 3.81802 19.182C5.13604 20.5 7.25736 20.5 11.5 20.5C11.8473 20.5 12.1804 20.5 12.5 20.4993" />
          <path d="M3 7.5H20" />
          <path d="M11.5 16H12.5M6.5 16H7.5" />
          <path d="M11.5 12H16.5M6.5 12H7.5" />
          <path d="M20 20L21.5 21.5M20.5 18C20.5 16.6193 19.3807 15.5 18 15.5C16.6193 15.5 15.5 16.6193 15.5 18C15.5 19.3807 16.6193 20.5 18 20.5C19.3807 20.5 20.5 19.3807 20.5 18Z" />
        </svg>
      </div>
    ),
    {
      ...size,
    }
  );
}
